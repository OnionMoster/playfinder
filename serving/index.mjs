export {
  applyHardFilters,
  mmrRerank,
  serveRanking,
} from '../build/study-core.mjs';

export const SERVING_ORDER = Object.freeze([
  'training-period reviewed-interaction exclusion',
  'session Not Interested exclusion',
  'budget hard filter',
  'platform hard filter',
  'explicit genre/tag hard filter',
  'deterministic MMR diversity reranking',
]);
