export type AssetCategory = "2D" | "3D" | "Animation" | "Audio" | "Music" | "Textures" | "UI" | "VFX" | "Unknown";

export type AiAssetAdvisorProvider = "none" | "codex-cli" | "claude-code-cli" | "openai" | "anthropic" | "gemini" | "deepseek" | "openrouter" | "groq" | "parallel" | "nace" | "custom";

export type AssetDownloadMode = "direct" | "assisted" | "manual";

export type AssetSourceSetting = {
  enabled: boolean;
  notes?: string;
};

export type CustomAssetSourceSetting = {
  id: string;
  title: string;
  url: string;
  category: AssetCategory;
  enabled: boolean;
  license?: string;
  reason?: string;
};

export type AssetPreferences = {
  completed: boolean;
  licensePolicy: "safe" | "any";
  browserEnabled: boolean;
  acquisitionMode: "existing" | "create" | "both";
  /** auto = the agent decides when a task needs assets; on-request = only when the user names the plugin or directly asks for an asset. */
  triggerMode: "auto" | "on-request";
  /** Optional folder the user chose at setup; the plugin may also write inside it. */
  projectsFolder?: string;
  accessMode?: "hermes" | "full" | "project" | "review" | "no";
};

export type AssetGrabberSettings = {
  preferences: AssetPreferences;
  assetAdvisor: {
    provider: AiAssetAdvisorProvider;
    apiKey?: string;
    model?: string;
    customProviderUrl?: string;
    deepseekApiKey?: string;
    customProviderApiKey?: string;
    customProviderModel?: string;
    deepseekModel?: string;
    allowNetworkAiRanking: boolean;
  };
  search: {
    allowManualResults: boolean;
    allowUnknownLicense: boolean;
    minLicenseSafety: number;
    defaultOutputDir?: string;
    keepSourceArchives: boolean;
    maxResultsDefault: number;
    maxDownloadBytes: number;
    maxExtractedBytes: number;
    maxExtractedFiles: number;
  };
  sources: Record<string, AssetSourceSetting>;
  priorityByCategory: Record<AssetCategory, string[]>;
  customSources: CustomAssetSourceSetting[];
};

export type AssetSearchOptions = {
  request: string;
  category?: AssetCategory;
  source?: string;
  limit?: number;
  includeManualResults?: boolean;
  useAdvisor?: boolean;
  /** Absolute path of the project the asset is for; its art style ranks results when the request names none. */
  projectPath?: string;
};

export type AssetAdvisorIntent = {
  request?: string;
  category?: AssetCategory;
  source?: string;
  includeManualResults?: boolean;
  formats?: string[];
  engine?: string;
  reason?: string;
};

export type AssetAdvisorTrace = {
  provider: AiAssetAdvisorProvider;
  used: boolean;
  originalRequest: string;
  request: string;
  category?: AssetCategory;
  source?: string;
  includeManualResults?: boolean;
  formats?: string[];
  engine?: string;
  reason?: string;
  error?: string;
};

export type ProviderDiagnostic = {
  source: string;
  ok: boolean;
  count: number;
  durationMs?: number;
  error?: string;
};

export type AssetSearchResponse = {
  results: AssetSearchResult[];
  diagnostics: ProviderDiagnostic[];
  advisor: AssetAdvisorTrace;
  relevance?: AssetRelevanceTrace;
  /** How the request was read. Category is inferred from wording unless passed explicitly. */
  interpretation?: { category: AssetCategory; categoryBasis: string; excludedTerms: string[]; requestedStyles: string[]; styleSource?: "request" | "project" | "none" };
  /** Art style read from the project at projectPath (files, code and docs; not visual). */
  projectStyle?: import("./project-style.js").ProjectStyle;
  /** Subject matches set aside because their declared style conflicts with the project's style. */
  offStyle?: { count: number; examples: string[]; note: string };
  /** Matching leads hidden because they need browser-assisted or manual retrieval. */
  withheld?: { count: number; sources: string[]; note: string };
  /** Present when nothing matched or no result's style is confirmed. Routes to try, never matches. */
  nextSteps?: string[];
};

export type AssetRelevanceTrace = {
  provider: AiAssetAdvisorProvider;
  used: boolean;
  basis: "metadata-only" | "web-grounded-metadata";
  protocol?: "typed-decisions";
  requestedModel?: string;
  model?: string;
  citations?: { url: string; title?: string; excerpts: string[] }[];
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
  evaluated: number;
  rejected: number;
  error?: string;
};

export type AssetDownloadFile = {
  url: string;
  /** Safe relative pack path; model texture/buffer dependencies retain folders. */
  fileName?: string;
};

export type AssetSearchResult = {
  source: string;
  id: string;
  title: string;
  url: string;
  category: AssetCategory;
  tags: string[];
  series: string[];
  license: string;
  score: number;
  reason: string;
  previewUrl?: string;
  fileCount?: number;
  downloadUrl?: string;
  downloadFileName?: string;
  downloadQuality?: "original" | "preview" | "unknown";
  downloadUrls?: AssetDownloadFile[];
  licenseUrl?: string;
  attributionRequired?: boolean;
  creator?: string;
  creatorUrl?: string;
  attribution?: string;
  licenseSafety?: number;
  downloadMode?: AssetDownloadMode;
  /** Metadata-only style evidence; never a visual check. */
  style?: import("./intent.js").StyleEvidence;
  assistInstructions?: string[];
  manualDownload?: boolean;
  generatedAsset?: AssetGeneratedAsset;
  derivedAsset?: import("./pixel-search.js").PixelSearchAsset;
  relevance?: { verdict: "relevant" | "irrelevant" | "uncertain"; confidence: number; reason: string };
  verification?: { basis: "pixel-color-and-subject-metadata"; color: string; visibleColorFraction?: number; note: string };
};

export type AssetGeneratedAsset = ProceduralSfxAsset | import("./generation.js").ProceduralAsset | import("./pixelbolt.js").PixelboltAsset;

export type ProceduralSfxAsset = {
  kind: "procedural-sfx";
  preset: string;
  seed: number;
  baseName: string;
};

export type GrabAssetOptions = AssetSearchOptions & {
  /** Exact "source:id" of a search_assets result; that result is grabbed or the call fails. */
  assetId?: string;
  outputDir?: string;
  fullPack?: boolean;
  includeSourceArchive?: boolean;
  overwrite?: boolean;
  formats?: string[];
  engine?: string;
  maxReadyFiles?: number;
};

export type PrepareExistingAssetOptions = {
  sourcePath: string;
  origin?: "existing" | "created";
  outputDir?: string;
  request?: string;
  engine?: string;
  formats?: string[];
  maxReadyFiles?: number;
  overwrite?: boolean;
  licenseName?: string;
  licenseUrl?: string;
  sourceUrl?: string;
  attributionRequired?: boolean;
};

export type EngineReadinessReport = {
  basis: "format-and-metadata-only-no-engine-import";
  engine?: string;
  recommendedFormats: string[];
  selectedFormats: string[];
  warnings: string[];
  notes: string[];
};

export type GrabbedAssetManifest = {
  request: string;
  generatedAt: string;
  source: string;
  asset: AssetSearchResult;
  paths: {
    root: string;
    pack: string;
    ready: string;
    archive?: string;
    manifest: string;
  };
  selectedFiles: string[];
  readyFiles: string[];
  allExtractedFileCount: number;
  conversions?: { source: string; output: string; operation: "embed-gltf-resources" }[];
  /** Why a requested conversion was not performed; the original files were delivered instead. */
  conversionWarnings?: string[];
  artifactFacts?: import("./artifact-facts.js").ArtifactFacts;
  cacheKey?: string;
  cacheHit?: boolean;
  advisor?: AssetAdvisorTrace;
  relevance?: AssetRelevanceTrace;
  diagnostics?: ProviderDiagnostic[];
  browser?: import("./browser.js").BrowserTrace;
  license: {
    name: string;
    url?: string;
    attributionRequired: boolean;
    shipSafe?: boolean;
  };
  engineReadiness?: EngineReadinessReport;
  importNotes: string[];
  alternatives: AssetSearchResult[];
};
