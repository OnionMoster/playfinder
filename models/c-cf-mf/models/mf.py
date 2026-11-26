import numpy as np
from scipy import sparse
from implicit.als import AlternatingLeastSquares
from implicit.bpr import BayesianPersonalizedRanking
class _ImplicitMFRecommender:
    model_name = "implicit_mf"
    def __init__(self):
        self.model = None
        self.user_item_matrix = None
        self.user_ids = []
        self.item_ids = []
        self.user_map = {}
        self.item_map = {}

    def _build_model(self):
        raise NotImplementedError

    def _prepare_training_matrix(self, matrix):
        return matrix

    def fit(self, user_item_matrix, user_ids, item_ids):
        matrix = sparse.csr_matrix(user_item_matrix, dtype=np.float32)
        matrix.sum_duplicates()
        matrix.eliminate_zeros()
        self.user_item_matrix = matrix
        self.user_ids = [str(user_id) for user_id in user_ids]
        self.item_ids = [str(item_id) for item_id in item_ids]
        self.user_map = {user_id: index for index, user_id in enumerate(self.user_ids)}
        self.item_map = {item_id: index for index, item_id in enumerate(self.item_ids)}
        self.model = self._build_model()
        train_matrix = self._prepare_training_matrix(matrix)
        self.model.fit(train_matrix, show_progress=False)

    def recommend(self, user_id, seen_items, k):
        user_index = self.user_map.get(str(user_id))
        if user_index is None:
            return []
        extra_seen = []
        for item_id in seen_items:
            item_index = self.item_map.get(str(item_id))
            if item_index is not None:
                extra_seen.append(item_index)
        filters = np.asarray(extra_seen, dtype=np.int32)
        history = self.user_item_matrix.getrow(user_index)
        blocked = set(history.indices)
        blocked.update(extra_seen)
        available = len(self.item_ids) - len(blocked)
        if available <= 0:
            return []
        indices, _ = self.model.recommend(
            userid=user_index,
            user_items=history,
            N=min(k, available),
            filter_already_liked_items=True,
            filter_items=filters if filters.size else None,
            recalculate_user=False,
        )
        return [self.item_ids[int(index)] for index in indices]

    def score(self, user_id, item_ids):
        user_index = self.user_map.get(str(user_id))
        if user_index is None:
            return [0.0] * len(item_ids)
        vector = np.asarray(self.model.user_factors[user_index])
        scores = []
        for item_id in item_ids:
            item_index = self.item_map.get(str(item_id))
            if item_index is None:
                scores.append(0.0)
            else:
                scores.append(float(np.dot(vector, self.model.item_factors[item_index])))
        return scores

class ALSRecommender(_ImplicitMFRecommender):
    model_name = "als"
    def __init__(
        self,
        factors=64,
        regularization=0.01,
        alpha=1.0,
        iterations=15,
        num_threads=1,
        random_state=42,
        calculate_training_loss=False,
    ):
        super().__init__()
        self.factors = factors
        self.regularization = regularization
        self.alpha = alpha
        self.iterations = iterations
        self.num_threads = num_threads
        self.random_state = random_state
        self.calculate_training_loss = calculate_training_loss

    def _build_model(self):
        return AlternatingLeastSquares(
            factors=self.factors,
            regularization=self.regularization,
            alpha=self.alpha,
            iterations=self.iterations,
            calculate_training_loss=self.calculate_training_loss,
            num_threads=self.num_threads,
            random_state=self.random_state,
        )

    @property
    def params(self):
        return {
            "name": self.model_name,
            "factors": self.factors,
            "regularization": self.regularization,
            "alpha": self.alpha,
            "iterations": self.iterations,
            "num_threads": self.num_threads,
            "random_state": self.random_state,
            "calculate_training_loss": self.calculate_training_loss,
        }

class BPRRecommender(_ImplicitMFRecommender):
    model_name = "bpr"
    def __init__(
        self,
        factors=64,
        learning_rate=0.01,
        regularization=0.01,
        iterations=100,
        verify_negative_samples=True,
        num_threads=1,
        random_state=42,
    ):
        super().__init__()
        self.factors = factors
        self.learning_rate = learning_rate
        self.regularization = regularization
        self.iterations = iterations
        self.verify_negative_samples = verify_negative_samples
        self.num_threads = num_threads
        self.random_state = random_state

    def _prepare_training_matrix(self, matrix):
        # bpr only uses 0 and 1
        binary = matrix.copy()
        binary.data = np.ones_like(binary.data, dtype=np.float32)
        return binary

    def _build_model(self):
        return BayesianPersonalizedRanking(
            factors=self.factors,
            learning_rate=self.learning_rate,
            regularization=self.regularization,
            iterations=self.iterations,
            verify_negative_samples=self.verify_negative_samples,
            num_threads=self.num_threads,
            random_state=self.random_state,
        )

    @property
    def params(self):
        return {
            "name": self.model_name,
            "factors": self.factors,
            "learning_rate": self.learning_rate,
            "regularization": self.regularization,
            "iterations": self.iterations,
            "verify_negative_samples": self.verify_negative_samples,
            "num_threads": self.num_threads,
            "random_state": self.random_state,
        }
