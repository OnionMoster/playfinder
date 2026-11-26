import numpy as np
from scipy import sparse
from sklearn.neighbors import NearestNeighbors
class ItemCFRecommender:
    def __init__(self, n_neighbors=50, n_jobs=1):
        self.n_neighbors = n_neighbors
        self.n_jobs = n_jobs
        self.user_item_matrix = None
        self.item_similarity = None
        self.user_ids = []
        self.item_ids = []
        self.user_map = {}
        self.item_map = {}

    def fit(self, user_item_matrix, user_ids, item_ids):
        matrix = sparse.csr_matrix(user_item_matrix, dtype=np.float32)
        self.user_item_matrix = matrix
        self.user_ids = [str(user_id) for user_id in user_ids]
        self.item_ids = [str(item_id) for item_id in item_ids]
        self.user_map = {user_id: index for index, user_id in enumerate(self.user_ids)}
        self.item_map = {item_id: index for index, item_id in enumerate(self.item_ids)}
        # item similarity
        item_users = matrix.T.tocsr()
        count = min(self.n_neighbors + 1, item_users.shape[0])
        knn = NearestNeighbors(n_neighbors=count, metric="cosine", algorithm="brute", n_jobs=self.n_jobs)
        knn.fit(item_users)
        distances, neighbors = knn.kneighbors(item_users)
        rows = np.repeat(np.arange(item_users.shape[0], dtype=np.int32), count)
        columns = neighbors.reshape(-1).astype(np.int32, copy=False)
        values = np.clip(1.0 - distances.reshape(-1), 0.0, 1.0).astype(np.float32, copy=False)
        keep = (rows != columns) & (values > 0.0)
        self.item_similarity = sparse.csr_matrix(
            (values[keep], (rows[keep], columns[keep])),
            shape=(item_users.shape[0], item_users.shape[0]),
            dtype=np.float32,
        )

    def recommend(self, user_id, seen_items, k):
        user_index = self.user_map.get(str(user_id))
        if user_index is None:
            return []
        scores = (self.user_item_matrix.getrow(user_index) @ self.item_similarity).toarray().ravel()
        for item_id in seen_items:
            item_index = self.item_map.get(str(item_id))
            if item_index is not None:
                scores[item_index] = -np.inf
        candidates = np.flatnonzero(np.isfinite(scores) & (scores > 0.0))
        ranked = sorted(candidates, key=lambda index: (-float(scores[index]), self.item_ids[index]))
        return [self.item_ids[index] for index in ranked[:k]]

    def score(self, user_id, item_ids):
        user_index = self.user_map.get(str(user_id))
        if user_index is None:
            return [0.0] * len(item_ids)
        scores = (self.user_item_matrix.getrow(user_index) @ self.item_similarity).toarray().ravel()
        result = []
        for item_id in item_ids:
            item_index = self.item_map.get(str(item_id))
            result.append(float(scores[item_index]) if item_index is not None else 0.0)
        return result

    def explain(self, user_id, recommended_item_id, n=3):
        user_index = self.user_map.get(str(user_id))
        item_index = self.item_map.get(str(recommended_item_id))
        if user_index is None or item_index is None:
            return []
        user_row = self.user_item_matrix.getrow(user_index)
        similarities = self.item_similarity.getcol(item_index).T.tocsr()
        contributions = user_row.multiply(similarities)
        if contributions.nnz == 0:
            return []
        order = sorted(
            range(contributions.nnz),
            key=lambda position: (
                -float(contributions.data[position]),
                self.item_ids[int(contributions.indices[position])],
            ),
        )
        explanations = []
        for position in order[:n]:
            source_index = int(contributions.indices[position])
            source_item = self.item_ids[source_index]
            explanations.append({
                "source_item_id": source_item,
                "contribution": float(contributions.data[position]),
                "message": f"Because you played {source_item}",
            })
        return explanations

    @property
    def params(self):
        return {
            "name": "itemcf",
            "n_neighbors": self.n_neighbors,
            "similarity": "cosine",
            "n_jobs": self.n_jobs,
        }
