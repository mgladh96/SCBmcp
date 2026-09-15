export { SEMANTIC_ALIAS_VERSION, expandIndustryAliases, expandPlaceAliases } from "./aliases.js";
export {
  parseEmployeeBand,
  parseEmployeeBands,
  rangeRelation,
  selectOverlappingBands,
} from "./bands.js";
export { compileStructuredQuery, sniLevel } from "./compile.js";
export {
  compileFailedError,
  countThenFetch,
  withCompileContext,
  type CountThenFetchSuccess,
} from "./fetch.js";
export {
  aliasRowToSemantic,
  projectToSemanticFields,
  resolveSemanticFields,
} from "./fields.js";
export {
  pickGeographyCategory,
  pickIndustryCategory,
  pickSizeCategory,
  pickStatusCategory,
} from "./geography.js";
export {
  compileQueryInputSchema,
  compiledFetchSchema,
  countThenFetchInputSchema,
  hasCompiledFilters,
  industrySlotSchema,
  structuredQuerySchema,
  type CountThenFetchInput,
  type StructuredQuery,
  type StructuredQueryInput,
} from "./schema.js";
export {
  DEFAULT_SEMANTIC_FIELDS,
  type CompileMetadataSource,
  type CompileResult,
  type CoverageEntry,
  type CoverageRelation,
  type ResolvedMappings,
} from "./types.js";
