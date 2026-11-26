"""PyTorch reimplementation of a LightFM-style hybrid factorisation machine.

score(u,i) = <p_u, q_i> + b_u + b_i, where item/user vectors are sums of
their feature embeddings (identity + content). Differs from the LightFM
library: exact WARP rank over the candidate set, uniform violator sampling,
and SparseAdam. Implements fit / recommend / score / params for B's eval.
"""

from __future__ import annotations

import math
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np
import torch
import torch.nn as nn


# 1. feature construction

@dataclass
class FeatureBank:
    """CSR-style container: entity -> (feature ids, feature weights)."""
    ptr: np.ndarray          # int64, (n_entities + 1,)
    flat: np.ndarray         # int64, (nnz,)
    weight: np.ndarray       # float32, (nnz,)
    n_features: int
    names: list = field(default_factory=list)

    @property
    def n_entities(self) -> int:
        return len(self.ptr) - 1

    def to(self, device):
        self.t_ptr = torch.as_tensor(self.ptr, device=device)
        self.t_flat = torch.as_tensor(self.flat, device=device)
        self.t_weight = torch.as_tensor(self.weight, device=device)
        lengths = self.t_ptr[1:] - self.t_ptr[:-1]
        self.t_offsets = torch.cat(
            [torch.zeros(1, dtype=torch.long, device=device), lengths.cumsum(0)[:-1]]
        )
        return self


def build_item_features(
    items_df,
    item_index: dict,
    list_cols: Sequence[str] = ("tags", "genres", "specs"),
    cat_cols: Sequence[str] = ("developer", "publisher"),
    price_col: str | None = "price",
    price_bins: Sequence[float] = (0.0, 0.01, 5.0, 15.0, 30.0, 60.0, 1e9),
    platform_cols: Sequence[str] = ("win", "mac", "linux"),
    extra: dict | None = None,
    min_df=20,   # int, or dict like {'default': 20, 'developer': 3}
    max_features_per_item: int = 40,
    identity: bool = True,
    identity_weight: float = 1.0,
    normalise: bool = True,
    vocab: dict | None = None,
) -> FeatureBank:
    """
    items_df   : the frozen items.parquet (needs an `item_id` column)
    item_index : item_id -> contiguous row used everywhere else
    extra      : optional {item_id: ["lda_7", "lda_23", ...]} for LDA / TF-IDF
    Items with no metadata keep only their identity feature, which is exactly
    the ~70% no-genre coverage case in our data.
    """
    n_items = len(item_index)
    raw = [[] for _ in range(n_items)]

    ids = items_df["item_id"].to_numpy()
    rows = np.array([item_index.get(int(x), -1) for x in ids], dtype=np.int64)

    def col(c):
        return items_df[c].to_numpy() if c in items_df.columns else None

    for c in list_cols:
        v = col(c)
        if v is None:
            continue
        for k, val in enumerate(v):
            r = rows[k]
            if r < 0 or val is None:
                continue
            if isinstance(val, float) and math.isnan(val):
                continue
            for t in val:
                if t:
                    raw[r].append(f"{c}:{str(t).strip().lower()}")

    for c in cat_cols:
        v = col(c)
        if v is None:
            continue
        for k, val in enumerate(v):
            r = rows[k]
            if r < 0 or val is None or (isinstance(val, float) and math.isnan(val)):
                continue
            raw[r].append(f"{c}:{str(val).strip().lower()}")

    if price_col and price_col in items_df.columns:
        p = np.nan_to_num(items_df[price_col].to_numpy(dtype=np.float64), nan=-1.0)
        b = np.digitize(p, np.asarray(price_bins))
        for k, bi in enumerate(b):
            if rows[k] >= 0 and p[k] >= 0:
                raw[rows[k]].append(f"price_bin:{int(bi)}")

    for c in platform_cols:
        v = col(c)
        if v is None:
            continue
        for k, val in enumerate(v):
            if rows[k] >= 0 and bool(val):
                raw[rows[k]].append(f"plat:{c}")

    if extra:
        for iid, feats in extra.items():
            r = item_index.get(int(iid), -1)
            if r >= 0:
                raw[r].extend(feats)

    if vocab is None:
        df_count = Counter(f for fl in raw for f in set(fl))
        if isinstance(min_df, dict):
            default = min_df.get("default", 20)
            def thr(f):
                return min_df.get(f.split(":", 1)[0], default)
        else:
            def thr(f):
                return min_df
        kept = [f for f, cnt in sorted(df_count.items(), key=lambda kv: -kv[1])
                if cnt >= thr(f)]
        vocab = {f: i for i, f in enumerate(kept)}   # re-enumerate: ids must be contiguous
    names = [None] * len(vocab)
    for f, i in vocab.items():
        names[i] = f

    base = len(vocab)
    if identity:
        names = names + [f"item_id:{i}" for i in range(n_items)]

    ptr = np.zeros(n_items + 1, dtype=np.int64)
    flat, weight = [], []
    for r in range(n_items):
        fids = [vocab[f] for f in dict.fromkeys(raw[r]) if f in vocab]
        if len(fids) > max_features_per_item:
            fids = fids[:max_features_per_item]
        ws = [1.0] * len(fids)
        if identity:
            fids.append(base + r)
            ws.append(identity_weight)
        if normalise and ws:
            s = float(sum(ws))
            ws = [w / s for w in ws]
        flat.extend(fids)
        weight.extend(ws)
        ptr[r + 1] = len(flat)

    bank = FeatureBank(ptr, np.asarray(flat, np.int64),
                       np.asarray(weight, np.float32), len(names), names)
    bank.vocab = vocab
    return bank


def build_user_features(u_rows, i_rows, item_feat_matrix, n_user_feats,
                        n_users, top_k=5, max_items=8, identity=True,
                        identity_weight=1.0, normalise=True, seed=0,
                        idf=True):
    """Simulated onboarding profile: the top_k content features of the items a
    user interacted with, i.e. the genres/tags they would have ticked at signup.

    item_feat_matrix : (n_items, F) int32, -1 padded, content features only.
    Returns a FeatureBank whose ids are [content features | user identities].
    """
    rng = np.random.default_rng(seed)
    order = np.argsort(u_rows, kind="stable")
    u_s, i_s = u_rows[order], i_rows[order]
    starts = np.searchsorted(u_s, np.arange(n_users + 1))

    # cap items per user so the (user, feature) explosion stays bounded
    keep = []
    for uu in range(n_users):
        a, b = starts[uu], starts[uu + 1]
        if b - a <= max_items:
            keep.append(np.arange(a, b))
        else:
            keep.append(rng.choice(np.arange(a, b), max_items, replace=False))
    keep = np.concatenate(keep) if keep else np.array([], dtype=np.int64)
    uu_, ii_ = u_s[keep], i_s[keep]

    feats = item_feat_matrix[ii_]                       # (M, F)
    rep_u = np.repeat(uu_, feats.shape[1])
    flat_f = feats.reshape(-1)
    ok = flat_f >= 0
    rep_u, flat_f = rep_u[ok], flat_f[ok]

    key = rep_u.astype(np.int64) * n_user_feats + flat_f
    key, cnt = np.unique(key, return_counts=True)
    ku, kf = key // n_user_feats, (key % n_user_feats).astype(np.int64)
    # Rank picks by count/log(global frequency). Raw counts would return the
    # same handful of ubiquitous tags (Indie, Singleplayer, Action) for almost
    # every user, so the profiles carry no discriminative signal at all.
    score = cnt.astype(np.float64)
    if idf:
        gdf = np.bincount(kf, weights=cnt.astype(np.float64),
                          minlength=n_user_feats)
        score = score / np.log1p(gdf[kf])
    ordr = np.lexsort((-score, ku))
    ku, kf = ku[ordr], kf[ordr]
    grp_start = np.r_[0, np.flatnonzero(np.diff(ku)) + 1]
    rank = np.arange(len(ku)) - np.repeat(grp_start, np.diff(np.r_[grp_start, len(ku)]))
    sel = rank < top_k
    ku, kf = ku[sel], kf[sel]

    per_user = [[] for _ in range(n_users)]
    for a, b in zip(ku, kf):
        per_user[a].append(int(b))

    ptr = np.zeros(n_users + 1, dtype=np.int64)
    flat, weight = [], []
    for r in range(n_users):
        fids = list(per_user[r])
        ws = [1.0] * len(fids)
        if identity:
            fids.append(n_user_feats + r)
            ws.append(identity_weight)
        if normalise and ws:
            t = float(sum(ws))
            ws = [w / t for w in ws]
        flat.extend(fids)
        weight.extend(ws)
        ptr[r + 1] = len(flat)

    names = [f"ufeat:{i}" for i in range(n_user_feats)] + \
            [f"user_id:{i}" for i in range(n_users)]
    bank = FeatureBank(ptr, np.asarray(flat, np.int64),
                       np.asarray(weight, np.float32), len(names), names)
    bank.n_content = n_user_feats
    return bank


def identity_bank(n: int, prefix="user_id") -> FeatureBank:
    return FeatureBank(np.arange(n + 1, dtype=np.int64),
                       np.arange(n, dtype=np.int64),
                       np.ones(n, dtype=np.float32),
                       n, [f"{prefix}:{i}" for i in range(n)])


# 2. model

class _Tower(nn.Module):
    def __init__(self, n_features, dim, init_std, sparse):
        super().__init__()
        self.emb = nn.EmbeddingBag(n_features, dim, mode="sum", sparse=sparse)
        self.bias = nn.EmbeddingBag(n_features, 1, mode="sum", sparse=sparse)
        nn.init.normal_(self.emb.weight, std=init_std)
        nn.init.zeros_(self.bias.weight)

    def forward(self, flat, offsets, weight):
        v = self.emb(flat, offsets, per_sample_weights=weight)
        b = self.bias(flat, offsets, per_sample_weights=weight).squeeze(-1)
        return v, b


def _gather_bag(bank: FeatureBank, idx: torch.Tensor):
    ptr, flat, w = bank.t_ptr, bank.t_flat, bank.t_weight
    starts = ptr[idx]
    lengths = ptr[idx + 1] - starts
    offsets = torch.cat([torch.zeros(1, dtype=torch.long, device=idx.device),
                         lengths.cumsum(0)[:-1]])
    n = int(lengths.sum())
    pos = torch.arange(n, device=idx.device)
    seg = torch.repeat_interleave(torch.arange(len(idx), device=idx.device), lengths)
    take = starts[seg] + (pos - offsets[seg])
    return flat[take], offsets, w[take]


class HybridFM(nn.Module):
    def __init__(self, user_bank, item_bank, dim=64, init_std=0.01,
                 sparse_user=True, sparse_item=False):
        super().__init__()
        self.user = _Tower(user_bank.n_features, dim, init_std, sparse_user)
        self.item = _Tower(item_bank.n_features, dim, init_std, sparse_item)
        self.user_bank, self.item_bank, self.dim = user_bank, item_bank, dim

    def all_items(self):
        b = self.item_bank
        return self.item(b.t_flat, b.t_offsets, b.t_weight)

    def users(self, idx):
        return self.user(*_gather_bag(self.user_bank, idx))

    def items_from_bank(self, bank: FeatureBank):
        """Score arbitrary (possibly unseen) items from a feature bank."""
        return self.item(bank.t_flat, bank.t_offsets, bank.t_weight)


# 3. recommender  (B's interface)

class HybridRecommender:
    def __init__(
        self,
        items_df=None,               # items.parquet — needed for the hybrid features
        dim: int = 64,
        loss: str = "warp",          # 'warp' | 'bpr'
        epochs: int = 15,
        batch_size: int = 4096,
        lr: float = 0.02,
        n_candidates: int | None = 8192,
        n_neg: int = 10,             # 'bpr' only
        margin: float = 1.0,
        use_confidence: bool = True,
        positive_label_only: bool = True,
        max_rank_weight: float = 10.0,
        warp_negative: str = "sample",   # 'sample' = true WARP | 'max' = hardest negative
        user_features: bool = False,   # onboarding profile in the user tower
        user_top_k: int = 5,
        user_identity_weight: float = 8.0,   # keep identity dominant for warm users
        user_idf: bool = True,
        sparse: bool = True,
        amp: bool = True,
        seed: int = 9727,
        device: str | None = None,
        feature_kwargs: dict | None = None,
        item_features_extra: dict | None = None,
        verbose: bool = True,
        name: str = "hybrid_warp",
    ):
        self.cfg = dict(
            name=name, dim=dim, loss=loss, epochs=epochs, batch_size=batch_size,
            lr=lr, n_candidates=n_candidates, n_neg=n_neg, margin=margin,
            use_confidence=use_confidence, positive_label_only=positive_label_only,
            max_rank_weight=max_rank_weight, warp_negative=warp_negative,
            user_features=user_features, user_top_k=user_top_k,
            user_identity_weight=user_identity_weight, user_idf=user_idf,
            sparse=sparse, amp=amp, seed=seed,
            feature_kwargs=dict(feature_kwargs or {}),
        )
        self.items_df = items_df
        self.item_features_extra = item_features_extra
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.verbose = verbose
        self.model = None

    def _log(self, *a):
        if self.verbose:
            print(*a, flush=True)

    @staticmethod
    def _as_frame(train_rows):
        import pandas as pd
        if isinstance(train_rows, pd.DataFrame):
            return train_rows
        if isinstance(train_rows, (list, tuple)) and train_rows:
            if isinstance(train_rows[0], dict):
                return pd.DataFrame(train_rows)
            return pd.DataFrame(list(train_rows),
                                columns=["user_id", "item_id", "label",
                                         "confidence"][:len(train_rows[0])])
        if isinstance(train_rows, np.ndarray):
            return pd.DataFrame(train_rows)
        raise TypeError(f"cannot interpret train_rows of type {type(train_rows)}")

    def fit(self, train_rows, all_item_ids=None, item_df=None):
        torch.manual_seed(self.cfg["seed"])
        np.random.seed(self.cfg["seed"])
        items_df = item_df if item_df is not None else self.items_df

        df = self._as_frame(train_rows)
        if self.cfg["positive_label_only"] and "label" in df.columns:
            df = df[df["label"] == 1]

        u_raw = df["user_id"].to_numpy()
        i_raw = df["item_id"].to_numpy()

        universe = (np.asarray(all_item_ids, dtype=np.int64)
                    if all_item_ids is not None else None)
        if universe is None:
            universe = items_df["item_id"].to_numpy() if items_df is not None else i_raw
        self.item_ids_ = np.unique(np.concatenate([np.asarray(universe), i_raw]))
        self.user_ids_ = np.unique(u_raw)
        self.iidx_ = {int(v): k for k, v in enumerate(self.item_ids_)}
        self.uidx_ = {int(v): k for k, v in enumerate(self.user_ids_)}
        n_u, n_i = len(self.user_ids_), len(self.item_ids_)

        u = np.array([self.uidx_[int(x)] for x in u_raw], dtype=np.int64)
        i = np.array([self.iidx_[int(x)] for x in i_raw], dtype=np.int64)

        if self.cfg["use_confidence"] and "confidence" in df.columns:
            c = df["confidence"].to_numpy(dtype=np.float32)
            c = c / max(float(c.mean()), 1e-8)
        else:
            c = np.ones(len(u), dtype=np.float32)

        ib = (build_item_features(items_df, self.iidx_,
                                  extra=self.item_features_extra,
                                  **self.cfg["feature_kwargs"])
              if items_df is not None else identity_bank(n_i, "item_id"))
        if self.cfg["user_features"] and items_df is not None:
            has_id = self.cfg["feature_kwargs"].get("identity", True)
            n_content = ib.n_features - (n_i if has_id else 0)
            lens = np.diff(ib.ptr) - (1 if has_id else 0)
            width = int(max(lens.max(), 1))
            mat = np.full((n_i, width), -1, dtype=np.int64)
            for r in range(n_i):
                a, b = ib.ptr[r], ib.ptr[r + 1] - (1 if has_id else 0)
                mat[r, :b - a] = ib.flat[a:b]
            ub = build_user_features(
                u, i, mat, n_content, n_u,
                top_k=self.cfg["user_top_k"],
                identity_weight=self.cfg["user_identity_weight"],
                idf=self.cfg["user_idf"],
                seed=self.cfg["seed"])
            self.user_content_ = (ub.ptr.copy(), ub.flat.copy(), n_content)
            self._log(f"  user onboarding features: {n_content:,} vocab, "
                      f"mean {float(np.mean(np.diff(ub.ptr))) - 1:.1f} picks/user")
        else:
            ub = identity_bank(n_u)
            self.user_content_ = None
        ib.to(self.device)
        ub.to(self.device)
        self.item_bank_, self.user_bank_ = ib, ub
        self.feature_vocab_ = getattr(ib, 'vocab', None)
        self._log(f"users={n_u:,}  items={n_i:,}  positives={len(u):,}  "
                  f"item_features={ib.n_features:,}  device={self.device}")

        self.model = HybridFM(ub, ib, dim=self.cfg["dim"],
                              sparse_user=self.cfg["sparse"],
                              sparse_item=False).to(self.device)

        if self.cfg["sparse"]:
            opts = [torch.optim.SparseAdam(list(self.model.user.parameters()),
                                           lr=self.cfg["lr"]),
                    torch.optim.Adam(list(self.model.item.parameters()),
                                     lr=self.cfg["lr"])]
        else:
            opts = [torch.optim.Adam(self.model.parameters(), lr=self.cfg["lr"])]

        amp = self.cfg["amp"] and self.device.type == "cuda"
        tu = torch.as_tensor(u, device=self.device)
        ti = torch.as_tensor(i, device=self.device)
        tc = torch.as_tensor(c, device=self.device)

        B = self.cfg["batch_size"]
        n_steps = math.ceil(len(u) / B)
        self.history_ = []

        for ep in range(self.cfg["epochs"]):
            perm = torch.randperm(len(u), device=self.device)
            tot, t0 = 0.0, time.time()
            for s in range(n_steps):
                sel = perm[s * B:(s + 1) * B]
                for o in opts:
                    o.zero_grad(set_to_none=True)
                with torch.autocast("cuda", dtype=torch.bfloat16, enabled=amp):
                    loss = self._loss(tu[sel], ti[sel], tc[sel], n_i)
                loss.backward()
                for o in opts:
                    o.step()
                tot += float(loss.detach())
            self.history_.append(tot / n_steps)
            rk = getattr(self, "_last_rank", None)
            self._log(f"epoch {ep + 1:>3}/{self.cfg['epochs']}  "
                      f"loss={tot / n_steps:.4f}"
                      + (f"  mean_rank={rk:,.0f}" if rk is not None else "")
                      + f"  {time.time() - t0:.1f}s")

        self._cache()
        return self

    def _loss(self, bu, bi, bc, n_i):
        Q, qb = self.model.all_items()
        P, pb = self.model.users(bu)

        K = self.cfg["n_candidates"]
        if K and K < n_i:
            cand = torch.randint(0, n_i, (K,), device=bu.device)
            cand = torch.unique(torch.cat([cand, bi]))
            pos_col = torch.searchsorted(cand, bi)
            Qc, qbc = Q[cand], qb[cand]
            scale = n_i / cand.numel()
        else:
            pos_col, Qc, qbc, scale = bi, Q, qb, 1.0

        s = P @ Qc.t() + pb.unsqueeze(1) + qbc.unsqueeze(0)
        s = s.float()
        pos = s.gather(1, pos_col.unsqueeze(1)).squeeze(1)

        if self.cfg["loss"] == "bpr":
            neg_col = torch.randint(0, s.size(1), (s.size(0), self.cfg["n_neg"]),
                                    device=s.device)
            l = -torch.nn.functional.logsigmoid(
                pos.unsqueeze(1) - s.gather(1, neg_col)).mean(1)
            return (l * bc).mean()

        m = self.cfg["margin"] - pos.unsqueeze(1) + s
        m = m.scatter(1, pos_col.unsqueeze(1),
                      torch.full_like(pos.unsqueeze(1), -1e4))
        viol = m > 0
        rank = viol.sum(1).float() * scale             # estimated rank of the positive
        self._last_rank = float(rank.mean().detach())  # progress signal; loss saturates
        w = torch.log1p(rank).clamp(max=self.cfg["max_rank_weight"])

        if self.cfg["warp_negative"] == "max":
            hinge = m.max(1).values.clamp(min=0)       # hardest negative: collapses
        else:
            r = torch.where(viol, torch.rand_like(m), torch.full_like(m, -1.0))
            pick = r.argmax(1, keepdim=True)           # uniform violator = true WARP
            hinge = m.gather(1, pick).squeeze(1).clamp(min=0)
        return (w * hinge * bc).mean()

    @torch.no_grad()
    def _cache(self):
        self.model.eval()
        Q, qb = self.model.all_items()
        self.Q_, self.qb_ = Q.detach().float(), qb.detach().float()

    @torch.no_grad()
    def _user_vec(self, rows: np.ndarray):
        return self.model.users(torch.as_tensor(rows, device=self.device))

    # --- B's per-user interface --- #
    @torch.no_grad()
    def recommend(self, user_id, seen_items=None, k=10):
        as_str = isinstance(user_id, str)   # B keys every id by str(); match it back
        r = self.uidx_.get(int(user_id), -1)
        if r < 0:
            return []
        P, pb = self._user_vec(np.array([r]))
        sc = (P @ self.Q_.t() + pb.unsqueeze(1) + self.qb_.unsqueeze(0)).squeeze(0)
        if seen_items is not None and len(seen_items):
            idx = [self.iidx_[int(x)] for x in seen_items if int(x) in self.iidx_]
            if idx:
                sc[torch.as_tensor(idx, device=self.device)] = -1e9
        top = sc.topk(min(k, sc.numel())).indices.cpu().numpy()
        out = self.item_ids_[top].tolist()
        return [str(x) for x in out] if as_str else out

    @torch.no_grad()
    def score(self, user_id, item_ids):
        item_ids = np.asarray(item_ids)
        out = np.zeros(len(item_ids), dtype=np.float32)   # finite: B min-max normalises
        r = self.uidx_.get(int(user_id), -1)
        if r < 0:
            return out
        cols = np.array([self.iidx_.get(int(x), -1) for x in item_ids])
        ok = cols >= 0
        if not ok.any():
            return out
        P, pb = self._user_vec(np.array([r]))
        it = torch.as_tensor(cols[ok], device=self.device)
        v = (P.squeeze(0) * self.Q_[it]).sum(1) + pb + self.qb_[it]
        v = v.float().cpu().numpy()
        out[ok] = v
        out[~ok] = float(v.min()) if len(v) else 0.0   # unknown items: floor, not -inf
        return out

    @torch.no_grad()
    def score_matrix(self, user_ids, item_ids, chunk=4096):
        """Dense (len(user_ids), len(item_ids)) score matrix; unknown users -> -inf row."""
        cols = np.array([self.iidx_.get(int(x), -1) for x in item_ids])
        col_ok = cols >= 0
        it = torch.as_tensor(cols[col_ok], device=self.device)
        Qi = self.Q_[it]; qbi = self.qb_[it]
        out = np.full((len(user_ids), len(item_ids)), -np.inf, dtype=np.float32)
        urows = np.array([self.uidx_.get(int(x), -1) for x in user_ids])
        for s0 in range(0, len(urows), chunk):
            part = urows[s0:s0 + chunk]
            ok = part >= 0
            if not ok.any():
                continue
            P, pb = self._user_vec(part[ok])
            sc = (P @ Qi.t() + pb.unsqueeze(1) + qbi.unsqueeze(0)).float().cpu().numpy()
            block = np.full((len(part), int(col_ok.sum())), -np.inf, dtype=np.float32)
            block[ok] = sc
            full = np.full((len(part), len(item_ids)), -np.inf, dtype=np.float32)
            full[:, col_ok] = block
            out[s0:s0 + chunk] = full
        return out

    # --- batched fast paths for D's own experiments --- #
    @torch.no_grad()
    def recommend_batch(self, user_ids, k=10, seen_map=None, chunk=4096):
        rows = np.array([self.uidx_.get(int(x), -1) for x in user_ids])
        out = np.full((len(rows), k), -1, dtype=np.int64)
        for s in range(0, len(rows), chunk):
            part = rows[s:s + chunk]
            ok = part >= 0
            if not ok.any():
                continue
            P, pb = self._user_vec(part[ok])
            sc = P @ self.Q_.t() + pb.unsqueeze(1) + self.qb_.unsqueeze(0)
            if seen_map:
                for j, uu in enumerate(np.asarray(user_ids)[s:s + chunk][ok]):
                    seen = seen_map.get(int(uu))
                    if seen:
                        idx = [self.iidx_[int(x)] for x in seen if int(x) in self.iidx_]
                        if idx:
                            sc[j, torch.as_tensor(idx, device=self.device)] = -1e9
            top = sc.topk(k, dim=1).indices.cpu().numpy()
            sub = np.full((len(part), k), -1, dtype=np.int64)
            sub[ok] = self.item_ids_[top]
            out[s:s + chunk] = sub
        return out

    @torch.no_grad()
    def cold_item_scores(self, user_ids, cold_items_df, feature_kwargs=None):
        """Score brand-new items that were never in training (item cold start)."""
        idx = {int(v): k for k, v in enumerate(cold_items_df["item_id"].to_numpy())}
        kw = dict(self.cfg["feature_kwargs"])
        kw.update(feature_kwargs or {})
        kw["identity"] = False                     # no id embedding exists for them
        kw["vocab"] = self.feature_vocab_          # MUST reuse the trained vocab
        bank = build_item_features(cold_items_df, idx, **kw).to(self.device)
        Qc, qbc = self.model.items_from_bank(bank)
        rows = np.array([self.uidx_[int(x)] for x in user_ids if int(x) in self.uidx_])
        P, pb = self._user_vec(rows)
        return (P @ Qc.t().float() + pb.unsqueeze(1) + qbc.float().unsqueeze(0)
                ).cpu().numpy(), np.asarray(cold_items_df["item_id"])

    @torch.no_grad()
    def cold_user_scores(self, user_ids, k=10, seen_map=None, chunk=4096):
        """Rank items for users represented ONLY by their onboarding features:
        the identity embedding is dropped, so no interaction history is used."""
        if self.user_content_ is None:
            raise RuntimeError("fit(..) with user_features=True first")
        ptr, flat, n_content = self.user_content_
        rows = np.array([self.uidx_.get(int(x), -1) for x in user_ids])
        out = np.full((len(rows), k), -1, dtype=np.int64)
        for s0 in range(0, len(rows), chunk):
            part = rows[s0:s0 + chunk]
            ok = part >= 0
            if not ok.any():
                continue
            sub_ptr, sub_flat, sub_w = [0], [], []
            for r in part[ok]:
                a, b = ptr[r], ptr[r + 1]
                fs = [int(x) for x in flat[a:b] if x < n_content]   # drop identity
                sub_flat.extend(fs)
                sub_w.extend([1.0 / len(fs)] * len(fs) if fs else [])
                sub_ptr.append(len(sub_flat))
            if not sub_flat:
                continue
            offs = torch.as_tensor(sub_ptr[:-1], device=self.device)
            P, pb = self.model.user(
                torch.as_tensor(sub_flat, device=self.device), offs,
                torch.as_tensor(sub_w, dtype=torch.float32, device=self.device))
            sc = P @ self.Q_.t() + pb.unsqueeze(1) + self.qb_.unsqueeze(0)
            if seen_map:
                for j, uu in enumerate(np.asarray(user_ids)[s0:s0 + chunk][ok]):
                    seen = seen_map.get(int(uu))
                    if seen:
                        idx = [self.iidx_[int(x)] for x in seen if int(x) in self.iidx_]
                        if idx:
                            sc[j, torch.as_tensor(idx, device=self.device)] = -1e9
            top = sc.topk(k, dim=1).indices.cpu().numpy()
            sub = np.full((len(part), k), -1, dtype=np.int64)
            sub[ok] = self.item_ids_[top]
            out[s0:s0 + chunk] = sub
        return out

    def save(self, path):
        """Persist everything needed to restore inference: weights, id maps,
        feature banks. Load with HybridRecommender.load(path)."""
        import pickle
        blob = dict(
            cfg=self.cfg,
            state_dict={k: v.cpu() for k, v in self.model.state_dict().items()},
            item_ids=self.item_ids_, user_ids=self.user_ids_,
            iidx=self.iidx_, uidx=self.uidx_,
            item_bank=self.item_bank_, user_bank=self.user_bank_,
            user_content=getattr(self, "user_content_", None),
            history=getattr(self, "history_", []),
            feature_vocab=getattr(self, "feature_vocab_", None),
            dim=self.model.dim,
        )
        with open(path, "wb") as fh:
            pickle.dump(blob, fh, protocol=4)
        return path

    @classmethod
    def load(cls, path, device=None):
        import pickle
        with open(path, "rb") as fh:
            b = pickle.load(fh)
        self = cls(**{k: v for k, v in b["cfg"].items()
                      if k in cls.__init__.__code__.co_varnames})
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.cfg = b["cfg"]
        self.item_ids_, self.user_ids_ = b["item_ids"], b["user_ids"]
        self.iidx_, self.uidx_ = b["iidx"], b["uidx"]
        self.item_bank_, self.user_bank_ = b["item_bank"], b["user_bank"]
        self.item_bank_.to(self.device); self.user_bank_.to(self.device)
        self.user_content_ = b.get("user_content")
        self.history_ = b.get("history", [])
        self.feature_vocab_ = b.get("feature_vocab")
        self.model = HybridFM(self.user_bank_, self.item_bank_, dim=b["dim"],
                              sparse_user=self.cfg.get("sparse", True),
                              sparse_item=False).to(self.device)
        self.model.load_state_dict(b["state_dict"])
        self._cache()
        return self

    @property
    def params(self) -> dict:
        p = dict(self.cfg)
        p["device"] = str(self.device)
        p["optimizer"] = "SparseAdam(user)+Adam(item)" if self.cfg["sparse"] else "Adam"
        if self.model is not None:
            p.update(n_users=len(self.user_ids_), n_items=len(self.item_ids_),
                     n_item_features=self.item_bank_.n_features,
                     final_train_loss=self.history_[-1] if self.history_ else None)
        return p


class OnboardingView:
    """A fitted HybridRecommender seen as if every user were brand new: the
    identity embedding is dropped and only the 3-5 onboarding picks remain.
    Implements B's interface, so it drops straight into B's evaluate()."""

    def __init__(self, model: "HybridRecommender", name="hybrid_onboarding"):
        self.m = model
        self.name = name
        self._cache = {}

    def _vec(self, row):
        if row in self._cache:
            return self._cache[row]
        ptr, flat, n_content = self.m.user_content_
        fs = [int(x) for x in flat[ptr[row]:ptr[row + 1]] if x < n_content]
        if not fs:
            return None
        dev = self.m.device
        with torch.no_grad():
            P, pb = self.m.model.user(
                torch.as_tensor(fs, device=dev),
                torch.zeros(1, dtype=torch.long, device=dev),
                torch.full((len(fs),), 1.0 / len(fs), device=dev))
        self._cache[row] = (P.squeeze(0), pb.squeeze(0))
        return self._cache[row]

    def recommend(self, user_id, seen_items=None, k=10):
        as_str = isinstance(user_id, str)
        row = self.m.uidx_.get(int(user_id), -1)
        v = self._vec(row) if row >= 0 else None
        if v is None:
            return []
        with torch.no_grad():
            sc = v[0] @ self.m.Q_.t() + v[1] + self.m.qb_
            if seen_items is not None and len(seen_items):
                idx = [self.m.iidx_[int(x)] for x in seen_items if int(x) in self.m.iidx_]
                if idx:
                    sc[torch.as_tensor(idx, device=self.m.device)] = -1e9
            top = sc.topk(min(k, sc.numel())).indices.cpu().numpy()
        out = self.m.item_ids_[top].tolist()
        return [str(x) for x in out] if as_str else out

    def score(self, user_id, item_ids):
        item_ids = np.asarray(item_ids)
        out = np.zeros(len(item_ids), dtype=np.float32)
        row = self.m.uidx_.get(int(user_id), -1)
        v = self._vec(row) if row >= 0 else None
        if v is None:
            return out
        cols = np.array([self.m.iidx_.get(int(x), -1) for x in item_ids])
        ok = cols >= 0
        if not ok.any():
            return out
        with torch.no_grad():
            it = torch.as_tensor(cols[ok], device=self.m.device)
            val = ((v[0] * self.m.Q_[it]).sum(1) + v[1] + self.m.qb_[it]).cpu().numpy()
        out[ok] = val
        out[~ok] = float(val.min()) if len(val) else 0.0
        return out

    @property
    def params(self):
        p = dict(self.m.params)
        p["name"] = self.name
        p["condition"] = "onboarding only: identity embedding dropped, "\
                         f"{self.m.cfg['user_top_k']} content picks retained"
        return p


if __name__ == "__main__":
    import pandas as pd

    rng = np.random.default_rng(0)
    n_u, n_i, K = 3000, 1200, 8
    ul, il = rng.integers(0, K, n_u), rng.integers(0, K, n_i)
    rows = []
    for uu in range(n_u):
        cands = np.flatnonzero(il == ul[uu])
        for it in rng.choice(cands, size=min(20, len(cands)), replace=False):
            rows.append((uu, int(it), 1, float(rng.random() * 3 + 1)))
    inter = pd.DataFrame(rows, columns=["user_id", "item_id", "label", "confidence"])
    items = pd.DataFrame({
        "item_id": np.arange(n_i),
        "tags": [[f"lat{il[k]}"] for k in range(n_i)],
        "genres": [[] for _ in range(n_i)],
        "developer": ["d"] * n_i,
        "price": rng.random(n_i) * 60,
        "win": True, "mac": False, "linux": False,
    })

    for loss in ("warp", "bpr"):
        m = HybridRecommender(items_df=items, dim=32, epochs=8, loss=loss,
                              batch_size=1024, lr=0.05, n_candidates=512,
                              feature_kwargs=dict(min_df=2), verbose=False)
        m.fit(inter, all_item_ids=np.arange(n_i))
        rec = m.recommend_batch(np.arange(300), k=10)
        hit = np.mean([np.mean(il[r] == ul[u]) for u, r in enumerate(rec)])
        print(f"{loss:5s} loss {m.history_[0]:.3f} -> {m.history_[-1]:.3f}   "
              f"latent-match@10 = {hit:.3f}   "
              f"single-user recommend {m.recommend(0, seen_items=[1, 2], k=5)}")