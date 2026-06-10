import { db, schema } from "@/lib/db";
import { sql } from "drizzle-orm";
import { getCachedCustomer } from "./client";
import { type AuthContext, type ConnectedAccount } from "./types";

type SnapshotAccountInput = string | (Pick<ConnectedAccount, "id"> & Partial<Pick<ConnectedAccount, "loginCustomerId" | "name">>);

type DateRange = { start: string; end: string };

type CampaignBenchmarkSnapshot = Record<string, unknown> & {
  accountId: string;
  campaignId: string;
  snapshotDate: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
};
type CampaignBenchmarkThirtyDaySnapshot = typeof schema.campaignBenchmarkThirtyDaySnapshots.$inferInsert;

export type BenchmarkSnapshotMode = "traffic" | "full";

export type BenchmarkCreditCounter = {
  used: number;
  budget: number | null;
};

export type BenchmarkSyncOptions = {
  days?: number;
  dateRange?: DateRange;
  mode?: BenchmarkSnapshotMode;
  creditBudget?: number;
  creditCounter?: BenchmarkCreditCounter;
  /** For callers that need to classify per-account failures instead of only counting them. */
  throwOnAccountError?: boolean;
};

type AccountContextRow = {
  customer?: {
    currency_code?: string;
    time_zone?: string;
  };
};

type CampaignMetricRow = {
  customer?: {
    currency_code?: string;
    time_zone?: string;
  };
  campaign?: {
    id?: string | number;
    name?: string;
    status?: string | number;
    advertising_channel_type?: string | number;
    bidding_strategy_type?: string | number;
  };
  segments?: {
    date?: string;
  };
  metrics?: {
    impressions?: number;
    clicks?: number;
    cost_micros?: number | string;
    conversions?: number;
    conversions_value?: number | string;
  };
};

type SearchCompetitiveMetricRow = {
  campaign?: { id?: string | number };
  segments?: { date?: string };
  metrics?: {
    search_impression_share?: number | string | null;
    search_top_impression_share?: number | string | null;
    search_absolute_top_impression_share?: number | string | null;
    search_budget_lost_impression_share?: number | string | null;
    search_rank_lost_impression_share?: number | string | null;
  };
};

type AssetCoverageRow = {
  campaign?: { id?: string | number };
  campaign_asset?: { field_type?: string | number; status?: string | number };
  ad_group_asset?: { field_type?: string | number; status?: string | number };
  customer_asset?: { field_type?: string | number; status?: string | number };
  asset_group_asset?: { field_type?: string | number; status?: string | number };
};

type KeywordMetricRow = {
  campaign?: { id?: string | number; status?: string | number };
  ad_group?: { status?: string | number };
  ad_group_criterion?: {
    status?: string | number;
    negative?: boolean;
    keyword?: { match_type?: string | number };
  };
  segments?: {
    date?: string;
  };
  metrics?: {
    impressions?: number;
    clicks?: number;
    cost_micros?: number | string;
    conversions?: number;
    conversions_value?: number | string;
  };
};

type FinalUrlRow = {
  campaign?: { name?: string };
  ad_group_ad?: {
    ad?: { final_urls?: string[] };
  };
  asset_group?: { final_urls?: string[] };
};

type CampaignCriterionRow = {
  campaign?: { id?: string | number };
  campaign_criterion?: {
    type?: string | number;
    negative?: boolean;
    location?: { geo_target_constant?: string };
    language?: { language_constant?: string };
  };
};

type AccountContext = {
  currencyCode: string;
  timeZone: string | null;
};

type BusinessContext = {
  businessDomain: string | null;
  industryCategory: string;
  businessNiche: string;
};

type AssetCounts = {
  sitelinkCount: number;
  calloutCount: number;
  structuredSnippetCount: number;
  imageAssetCount: number;
};

type KeywordMix = {
  broadImpressions: number;
  broadClicks: number;
  broadCostMicros: number;
  broadConversions: number;
  broadConversionsValue: number;
  phraseImpressions: number;
  phraseClicks: number;
  phraseCostMicros: number;
  phraseConversions: number;
  phraseConversionsValue: number;
  exactImpressions: number;
  exactClicks: number;
  exactCostMicros: number;
  exactConversions: number;
  exactConversionsValue: number;
};

type SearchCompetitiveMetrics = {
  searchImpressionShare: number | null;
  searchTopImpressionShare: number | null;
  searchAbsoluteTopImpressionShare: number | null;
  searchBudgetLostImpressionShare: number | null;
  searchRankLostImpressionShare: number | null;
};

type CampaignTargeting = {
  geoTargetConstants: string[];
  negativeGeoTargetConstants: string[];
  languageConstants: string[];
};

const EMPTY_ASSETS: AssetCounts = {
  sitelinkCount: 0,
  calloutCount: 0,
  structuredSnippetCount: 0,
  imageAssetCount: 0,
};

const EMPTY_KEYWORD_MIX: KeywordMix = {
  broadImpressions: 0,
  broadClicks: 0,
  broadCostMicros: 0,
  broadConversions: 0,
  broadConversionsValue: 0,
  phraseImpressions: 0,
  phraseClicks: 0,
  phraseCostMicros: 0,
  phraseConversions: 0,
  phraseConversionsValue: 0,
  exactImpressions: 0,
  exactClicks: 0,
  exactCostMicros: 0,
  exactConversions: 0,
  exactConversionsValue: 0,
};

const EMPTY_COMPETITIVE: SearchCompetitiveMetrics = {
  searchImpressionShare: null,
  searchTopImpressionShare: null,
  searchAbsoluteTopImpressionShare: null,
  searchBudgetLostImpressionShare: null,
  searchRankLostImpressionShare: null,
};

const EMPTY_TARGETING: CampaignTargeting = {
  geoTargetConstants: [],
  negativeGeoTargetConstants: [],
  languageConstants: [],
};

export function getDateRangeEndingYesterday(days: number, now = new Date()): DateRange {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - Math.max(1, days) + 1);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function normalizeSnapshotAccount(account: SnapshotAccountInput): Pick<ConnectedAccount, "id"> & Partial<Pick<ConnectedAccount, "loginCustomerId" | "name">> {
  return typeof account === "string" ? { id: account } : account;
}

const CAMPAIGN_STATUS_ENUM: Record<string, string> = {
  "2": "ENABLED",
  "3": "PAUSED",
  "4": "REMOVED",
};

const ADVERTISING_CHANNEL_TYPE_ENUM: Record<string, string> = {
  "2": "SEARCH",
  "3": "DISPLAY",
  "4": "SHOPPING",
  "5": "HOTEL",
  "6": "VIDEO",
  "7": "MULTI_CHANNEL",
  "9": "LOCAL",
  "10": "PERFORMANCE_MAX",
  "11": "SMART",
  "13": "LOCAL_SERVICES",
  "14": "DEMAND_GEN",
  "15": "TRAVEL",
};

const BIDDING_STRATEGY_TYPE_ENUM: Record<string, string> = {
  "2": "MANUAL_CPC",
  "3": "MANUAL_CPM",
  "4": "PAGE_ONE_PROMOTED",
  "5": "TARGET_CPA",
  "6": "TARGET_OUTRANK_SHARE",
  "7": "TARGET_ROAS",
  "8": "TARGET_SPEND",
  "9": "TARGET_SPEND",
  "10": "MAXIMIZE_CONVERSIONS",
  "11": "MAXIMIZE_CONVERSION_VALUE",
  "12": "COMMISSION",
  "13": "ENHANCED_CPC",
  "14": "MANUAL_CPV",
  "15": "TARGET_IMPRESSION_SHARE",
  "16": "PERCENT_CPC",
  "17": "TARGET_CPM",
  "18": "FIXED_CPM",
  "19": "TARGET_CPV",
};

function normalizeEnum(value: unknown, enumMap?: Record<string, string>): string | null {
  if (value == null) return null;
  const normalized = String(value).toUpperCase();
  return enumMap?.[normalized] ?? normalized;
}

function metricNumber(value: unknown, fallback = 0) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableMetricNumber(value: unknown) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isEnabled(value: unknown) {
  const normalized = normalizeEnum(value);
  return normalized == null || normalized === "ENABLED" || normalized === "2";
}

function assetCountsForType(counts: AssetCounts, fieldType: unknown) {
  const type = normalizeEnum(fieldType);
  if (!type) return;
  if (type.includes("SITELINK")) counts.sitelinkCount += 1;
  else if (type.includes("CALLOUT")) counts.calloutCount += 1;
  else if (type.includes("STRUCTURED_SNIPPET")) counts.structuredSnippetCount += 1;
  else if (type.includes("IMAGE")) counts.imageAssetCount += 1;
}

function assetMapKey(campaignId: string) {
  return campaignId;
}

function segmentMapKey(campaignId: string, snapshotDate: string) {
  return `${campaignId}|${snapshotDate}`;
}

function searchCompetitiveMapKey(campaignId: string, snapshotDate: string) {
  return `${campaignId}|${snapshotDate}`;
}

function createCreditTracker(options: Pick<BenchmarkSyncOptions, "creditBudget" | "creditCounter"> = {}) {
  const counter = options.creditCounter ?? { used: 0, budget: options.creditBudget ?? null };
  if (options.creditBudget != null) counter.budget = options.creditBudget;

  return {
    counter,
    reserve(credits = 1) {
      if (counter.budget != null && counter.used + credits > counter.budget) {
        throw new BenchmarkCreditBudgetExceeded(counter.used, counter.budget, credits);
      }
      counter.used += credits;
    },
  };
}

export class BenchmarkCreditBudgetExceeded extends Error {
  constructor(public readonly used: number, public readonly budget: number, public readonly requested: number) {
    super(`Benchmark credit budget exceeded: used ${used}/${budget}, requested ${requested}`);
    this.name = "BenchmarkCreditBudgetExceeded";
  }
}

function getOrCreateAssetCounts(map: Map<string, AssetCounts>, campaignId: string) {
  const key = assetMapKey(campaignId);
  const current = map.get(key);
  if (current) return current;
  const next = { ...EMPTY_ASSETS };
  map.set(key, next);
  return next;
}

function getOrCreateKeywordMix(
  map: Map<string, KeywordMix>,
  campaignId: string,
  snapshotDate: string,
) {
  const key = segmentMapKey(campaignId, snapshotDate);
  const current = map.get(key);
  if (current) return current;
  const next = { ...EMPTY_KEYWORD_MIX };
  map.set(key, next);
  return next;
}

function getOrCreateTargeting(map: Map<string, CampaignTargeting>, campaignId: string) {
  const current = map.get(campaignId);
  if (current) return current;
  const next: CampaignTargeting = {
    geoTargetConstants: [],
    negativeGeoTargetConstants: [],
    languageConstants: [],
  };
  map.set(campaignId, next);
  return next;
}

function dedupeSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function parseDomain(url: string | undefined) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

type BusinessClassification = {
  industryCategory: string;
  businessNiche: string;
};

type BusinessNicheRule = BusinessClassification & {
  pattern: RegExp;
};

const BUSINESS_NICHE_RULES: BusinessNicheRule[] = [
  { industryCategory: "Education", businessNiche: "Trade / Career School", pattern: /(northwestcareercollege|career college|trade school|hvac tech|dental assistant|medical assistant|phlebotomy|pharmacy technician|all program)/ },
  { industryCategory: "Retail", businessNiche: "Eyewear / Optical Retail", pattern: /(youtopoptical|prescription glasses|eyeglasses|sunglasses)/ },
  { industryCategory: "Ecommerce", businessNiche: "Marketplace Retail", pattern: /(amazon\.com\.au|amazon\.com|amazon marketplace)/ },
  { industryCategory: "Mobile Apps", businessNiche: "Recipe App", pattern: /(einfache schnelle rezepte|low carb rezepte|recette|recipe app|play\.google\.com.*recipe)/ },
  { industryCategory: "Healthcare", businessNiche: "Osteopathy / Physical Therapy", pattern: /(coolyosteo|osteopath|osteopathy)/ },
  { industryCategory: "Home Services", businessNiche: "Painting", pattern: /(prettygoodpainting|bosflocoatings|gwhomeimprovementservices|house painters?|painting services?)/ },
  { industryCategory: "Real Estate", businessNiche: "New Development / Apartments", pattern: /(propertieslombok|lithos|allihoop|co[- ]?living|coliving|para[íi]so mahahual|maha[h]?ual)/ },
  { industryCategory: "Ecommerce", businessNiche: "Apparel / Fashion Retail", pattern: /(lauven\.co|soofandbloom|marlovale|sage[- ]sydney|bourrienne|swanuniform|florence mini dress|evening set|robe longue|linen pants|custom soccer uniforms|uniforms?)/ },
  { industryCategory: "Ecommerce", businessNiche: "Kitchen / Cookware Retail", pattern: /(santoku ?knives?|kitchen knives?|whetstones?|wheatstones?|minato)/ },
  { industryCategory: "Media / Publishing", businessNiche: "News / Video Publisher", pattern: /(gazetesi|yenisoke|aljazeera360|googlevideo|videoviews|demandgen_traffic|haber|video\/|youtu\.be|shorts\/subs|music video|no love for the middle child|wul up)/ },
  { industryCategory: "B2B Services", businessNiche: "Branding / Web Design Agency", pattern: /(brandemic|brand identity|ui & ux|ui ux|web[- ]dev|web design|streaming video profesional|conceptoweb)/ },
  { industryCategory: "B2B Services", businessNiche: "Security Services", pattern: /(northeasternsecurity|commercial security|security wb|security systems?)/ },
  { industryCategory: "Local Services", businessNiche: "Genealogy / Family History", pattern: /(legacytree|genealogy|family history|citizenship by descent)/ },
  { industryCategory: "Industrial / Manufacturing", businessNiche: "Industrial Machinery / Tools", pattern: /(calismakina|machine tools?|cnc|tokarn|токарн|фрезерн|frezern|ironwest|plastik|teşhir|teshir|shop display|detectores|insuflador|trava quedas|epi|work at height|espaço confinado|sanitary equipment|duplex 2205|316h|jamesduva)/ },
  { industryCategory: "Home Services", businessNiche: "Locksmith", pattern: /(locksmith|burnhamslocksmith|automobile locksmith|residential locksmith)/ },
  { industryCategory: "Automotive", businessNiche: "Cash for Cars / Car Buying", pattern: /(cash for cars|car buyer|car removals?|fast cash car|carbuyerqld)/ },
  { industryCategory: "Automotive", businessNiche: "Car Electronics / Audio", pattern: /(carplay|radio installation|radioking|car audio|speaker dust proof)/ },
  { industryCategory: "Automotive", businessNiche: "Exotic / Luxury Car Dealer", pattern: /(opulentexotics|exotic cars?|luxury cars?|supercar|search \| buyers|search \| sellers)/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Trading / Finance Education", pattern: /(gopocket|option10|option trading|tradingworkshop|finance ?rock|geschaeftsadresse|geschäftsadresse|buchhaltung|treuhand)/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Lending / Credit", pattern: /(anytiercredit|billhero|credit|loan|quick & easy)/ },
  { industryCategory: "Legal", businessNiche: "Law Firm", pattern: /(advokat|адвокат|legal|lawyer|attorney)/ },
  { industryCategory: "Travel / Hospitality", businessNiche: "Travel Agency / Tours", pattern: /(cocoverdeviagens|viagens|jer[ií]|praias|tourism|travel agency|exploorperu|exploor peru)/ },
  { industryCategory: "Travel / Hospitality", businessNiche: "Vacation Rentals / Cabins", pattern: /(georgiacfy|cabin pages?|vacation cabins?|cabin rentals?|stay portland|family & group - stay)/ },
  { industryCategory: "Ecommerce", businessNiche: "Home Goods / Furniture Retail", pattern: /(modregohogar|hogar|home goods|grounding sheets|sheets sewn|hmcarquitectos|shedpro|custom sheds|spanline|countertopworld|countertop world|countertops?)/ },
  { industryCategory: "Ecommerce", businessNiche: "Beauty / Cosmetics Retail", pattern: /(madluvv|eyebrow|brow|makeup|beauty products?)/ },
  { industryCategory: "Ecommerce", businessNiche: "Alcohol / Beverage Retail", pattern: /(vinimediat|hennessy|coniac|cognac|spirits?|wine|beverage)/ },
  { industryCategory: "Ecommerce", businessNiche: "Health Supplements", pattern: /(biotane|melatonin|vitamin b6|supplements?)/ },
  { industryCategory: "Home Improvement Retail", businessNiche: "Lighting / Electrical Retail", pattern: /(ilume\.cz|ring light|kruhove svetlo|kruhové světlo|softbox|kosmetick[aá] světla|lightbox|лайтбокс|neonovi|неон|об.?ємні літери|вывески|vyveski|designer lighting|print3d\.africa)/ },
  { industryCategory: "Energy", businessNiche: "Solar / Renewable Energy", pattern: /(renergy|solar|panel solar|ecopanel|panelsolar|renewable energy)/ },
  { industryCategory: "Local Services", businessNiche: "Restaurant / Food Service", pattern: /(masala ministry|oraclubjaipur|restaurant|cafe|food service)/ },
  { industryCategory: "Local Services", businessNiche: "Funeral Services", pattern: /(funeraria|cremaciones|funeral|cremation)/ },
  { industryCategory: "Education", businessNiche: "Trade / Career School", pattern: /(northwestcareercollege|career college|trade school|hvac tech|dental assistant|medical assistant|phlebotomy|pharmacy technician)/ },
  { industryCategory: "Dental", businessNiche: "Dental Practice", pattern: /(magmadis|dentis|dental|dentist)/ },
  { industryCategory: "Healthcare", businessNiche: "Plastic / Cosmetic Surgery", pattern: /(plastic surg|cosmetic surg|cirujanos? pl[aá]sticos?|abdominoplast(?:y|ia)?|cervicoplast|tummy tuck|rhinoplast|blepharoplast|liposuction)/ },
  { industryCategory: "Healthcare", businessNiche: "Medical Clinic", pattern: /(혈관센터|여성의학센터|인터벤션)/ },
  { industryCategory: "Healthcare", businessNiche: "Mental Health / Psychology", pattern: /(psicolog[ií]a|psychology|psychologist|terapia psicol[oó]gica)/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Insurance", pattern: /(roojai|ประกัน|insure|maxclick.*insure)/ },
  { industryCategory: "Ecommerce", businessNiche: "Baby / Diaper Retail", pattern: /(підгузки|подгузки|трусики)/ },
  { industryCategory: "Ecommerce", businessNiche: "Battery / Power Supply Retail", pattern: /(акумулятори|аккумуляторы|дбж|акб|ups batteries?)/ },
  { industryCategory: "Ecommerce", businessNiche: "Packaging Supplies", pattern: /(пакети вакуумні|вакуумн[іи] пакет|мішки поліетиленові|poly bags?|vacuum bags?)/ },
  { industryCategory: "Home Improvement Retail", businessNiche: "Electrical / HVAC Supplies", pattern: /(elektriciteit|verwarming|ventilatie|сантехніка|сантехника|опалення|отопление)/ },
  { industryCategory: "Home Services", businessNiche: "Doors / Windows", pattern: /(вхідні двері|межк[іи]мнатн[іи]|межкомнатн[іи]|dvere|drzwi)/ },
  { industryCategory: "Home Services", businessNiche: "Pest Control", pattern: /(蜂駆除|dezinsekciya|дезинсекц|дезінсекц)/ },
  { industryCategory: "Home Services", businessNiche: "Junk Removal", pattern: /(вывоз мусора|вив[іi]з см[іi]ття|стар[іи] мебл[іи])/ },
  { industryCategory: "Home Services", businessNiche: "Cleaning", pattern: /(кл[іи]н[іи]нг|клининг)/ },
  { industryCategory: "Ecommerce", businessNiche: "Lab / Scientific Supplies", pattern: /(基礎實驗器材|個人防護用品|泛用儀器|量測儀器|液體處理設備|lab supplies|scientific supplies)/ },
  { industryCategory: "Ecommerce", businessNiche: "Industrial Supplies", pattern: /(wire rope|gate valve|蝶阀|butterfly valve|роз'єми|кріплення|fasteners?)/ },
  { industryCategory: "Ecommerce", businessNiche: "Art / Artist Website Commerce", pattern: /(art storefronts|arthelper)/ },
  { industryCategory: "Ecommerce", businessNiche: "Custom Apparel Printing", pattern: /(друк\+вишивка|вишивка одяг|оптове пошиття|custom apparel|embroidery)/ },
  { industryCategory: "Retail", businessNiche: "Jewelry / Gold Retail", pattern: /(عقود ذهب|خواتم ذهب|غوايش ذهب|gold jewelry|gold rings?)/ },
  { industryCategory: "Healthcare", businessNiche: "Home Care / Caregivers", pattern: /(cuidadores|home care|caregivers?|elder care)/ },
  { industryCategory: "Healthcare", businessNiche: "Fertility / IVF Clinic", pattern: /\b(ivf|fiv|fertility|fertilidad|in vitro fertilization|reproductive medicine)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Medical Supplies / Devices", pattern: /\b(blood pressure monitor|blood glucose|血壓計|血糖機|neu100|підгузки|памперс|diapers?|medical supplies?)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Perfusion / Specialty Medicine", pattern: /\b(perfusion|keystoneperfusion|nrp\.keystone|normothermic regional perfusion)\b/ },
  { industryCategory: "Automotive", businessNiche: "Auto Repair / Tires", pattern: /\b(auto service|automotive service|car repair|mechanic|tire pros?|tyres?|tires?|rwc|wulkdrive|wulkanizacja|сер[вв]іс автомоб|автосервіс)\b/ },
  { industryCategory: "Automotive", businessNiche: "Auto Detailing / Tint", pattern: /\b(auto salon|auto spa|autospa|ceramic coating|paint protection film|vinyl wrap|window tint|ppf|detailing|graphene|customkingsjax|thehavenautospa|wrap performance max|dfwautocustoms)\b/ },
  { industryCategory: "Automotive", businessNiche: "Electronics / Device Repair", pattern: /\b(iphone|macbook|imac|phone repair|screen repair|applefix|electronics repair)\b/ },
  { industryCategory: "Automotive", businessNiche: "Collision / Auto Body Repair", pattern: /\b(auto body|collision repair|body shop|fixautoprovo|dent repair)\b/ },
  { industryCategory: "Retail", businessNiche: "Building Materials / Home Improvement Retail", pattern: /\b(materialdepot|building materials|wooden flooring|laminates?|plywood|panels?|quartz|tiles?|wallpapers?|wood|timber|lumber|madera|pallets?|embalajes|packaging materials?|сантехніка|опалення|heating center|grzewczych|piecyki)\b/ },
  { industryCategory: "Retail", businessNiche: "Furniture Retail", pattern: /\b(furniture|sofa|office furniture|design & planning|commercial office|td-furniture|lazio sofa|ofo-orlando)\b/ },
  { industryCategory: "Retail", businessNiche: "Jewelry / Gold Retail", pattern: /\b(jewelry|jewellery|bijoux|gold buyer|buy gold|local store - bijoux|agence de l'or|delor)\b/ },
  { industryCategory: "Retail", businessNiche: "Formalwear / Apparel Retail", pattern: /\b(trajes|suits?|tuxedo|toga|togas|laurenti|elegancepuebla|apparel|fashion|clothing|shoes|jewelry)\b/ },
  { industryCategory: "Local Services", businessNiche: "Restaurant / Food Service", pattern: /\b(restaurant|cafe|pizza|barbecue|bbq|food truck|catering)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Grocery / Food Retail", pattern: /\b(dhatuorganics|organic|rice|rajmudi|rajamudi|sona masoori|fresh produce|vegetables|sprouted flour|porridge|nut & seed|butters?|grocery)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Gaming / Virtual Goods", pattern: /\b(playhop|pokestar|pokemon|acnh|acnhmall|dreamlight valley|game coins?|gaming marketplace|virtual goods?)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Promotional Products", pattern: /\b(brindes?|moleskine|ecobag|squeeze|powerbank|power bank|pins?|kit onboarding|mochila|copos|garrafa|viseira|bolsa termica|personalizados?)\b/ },
  { industryCategory: "Retail", businessNiche: "Consumer Electronics / Appliance Retail", pattern: /\b(newsamsung|samsung|smart fridge|blood pressure monitor|izoly|bilgisayar|computer retail|elektronik|электроніка)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Hair Restoration / Trichology", pattern: /\b(hair restoration|hair transplant|trapianto capelli|capelli|hair loss|trichology)\b/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Finance / Trading Education", pattern: /\b(trading academy|trading college|forex|wealth expo|day trading|trader education)\b/ },
  { industryCategory: "B2B Services", businessNiche: "Marketing Agency", pattern: /\b(marketing agency|advertising agency|growth strateg|creative agency|branding agency|agencia de marketing|광고 대행)\b/ },
  { industryCategory: "Education", businessNiche: "Driving School", pattern: /\b(driving school|drivingschool|driving lesson|driving teacher|운전학원|운전선생)\b/ },
  { industryCategory: "Local Services", businessNiche: "Laundry / Dry Cleaning", pattern: /\b(laundry|dry cleaning|laundromat|wash and fold)\b/ },
  { industryCategory: "Logistics / Transportation", businessNiche: "Freight / Shipping", pattern: /\b(freight|shipping|logistics|transport and moving|mudanzas|fletes?|fcl|lcl|1688|중국 ?수입|해상운송|грузоперевозки|грузоперевезення)\b/ },
  { industryCategory: "Home Services", businessNiche: "Storage / Moving", pattern: /\b(storage|self storage|moving|free pick-up service|boxie24|movers)\b/ },
  { industryCategory: "Home Services", businessNiche: "Fencing", pattern: /\b(fencing|fence experts?|abffencing|fence installation|wood fence|vinyl fence)\b/ },
  { industryCategory: "Home Services", businessNiche: "Awnings / Shade", pattern: /\b(awnings?|mqawnings|shade structure|patio cover)\b/ },
  { industryCategory: "Home Improvement Retail", businessNiche: "Building Materials", pattern: /\b(building materials|wood|timber|lumber|madera|pallets?|embalajes|packaging materials?)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Auto Parts / Accessories", pattern: /\b(auto parts?|car batteries|automotive accessories|автомобільних акумуляторів)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Adult Retail", pattern: /\b(sex shop|intimate products|интимных товаров)\b/ },
  { industryCategory: "Real Estate", businessNiche: "New Development / Apartments", pattern: /\b(luxury apartments?|bhk apartments?|new development|real estate project|krishna bhumi|kolkata lead gen|skyi|5rc|harsha|residential development)\b/ },
  { industryCategory: "Local Services", businessNiche: "Pet Boarding / Daycare", pattern: /\b(pawradisepet|collar\.pet|pet hotel|dog hotel|pet boarding|dog boarding|cat boarding|boarding|kennel|dog daycare|dog day care|pet daycare|pawsvip|dog resort|pet resort)\b/ },
  { industryCategory: "Local Services", businessNiche: "Pet Grooming", pattern: /\b(pet groom|dog groom|groomer|mobile groom)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Veterinary Clinic", pattern: /\b(veterinary|veterinarian|vet clinic|mobile vet|vet|animal hospital|pet hospital)\b/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Bookkeeping", pattern: /\b(bookkeeping|book keeper|bookkeeper|quickbooks|accounts payable|accounts receivable|payroll service)\b/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Accounting / Tax", pattern: /\b(accounting|accountant|cpa|tax prep|tax preparation|tax planning|tax service)\b/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Financial Planning / Wealth Management", pattern: /\b(financial planning|wealth management|hnw|capital partners|fbbcapitalpartners|retirement planning)\b/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Insurance", pattern: /\b(insurance|insurer|brokerage|medicare plan|life insurance|auto insurance|home insurance)\b/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Lending / Credit", pattern: /\b(mortgage|loan|lender|credit repair|debt relief|financing)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "Social Media Analytics Software", pattern: /\b(syncly|social listening|social analytics|video analytics|creator discovery|tiktok niche)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "Meeting Notes / Transcription Software", pattern: /\b(securememo|meeting notes?|議事録|transcription|transcribe)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "Amazon Seller Software", pattern: /\b(bqool|seller snap|amazon seller|repricer|seller software)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "Appointment Scheduling Software", pattern: /\b(confirmaci[oó]n de citas|consultorios m[eé]dicos|dentistas|barber[ií]as|psicologos|salones de belleza|appointment scheduling)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "AI Agent / MCP Software", pattern: /\b(mcp|ai agent|agentic|openclaw|hermes|notfair|codex|claude|llm|ai automation)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "Document Automation Software", pattern: /\b(document automation|dochero|legal document|forms automation|document generation)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "Developer Analytics Software", pattern: /\b(devstats|engineering metrics|dora|dev productivity|developer productivity)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "CRM / Sales Software", pattern: /\b(crm|sales software|pipeline management|lead management)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "SaaS / Business Software", pattern: /\b(saas|software|platform|api|workflow automation|business automation)\b/ },
  { industryCategory: "Dental", businessNiche: "Dental Practice", pattern: /\b(dental|dentist|orthodont|orthodontist|invisalign|teeth whitening)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Med Spa / Aesthetics", pattern: /\b(medspa|med spa|botox|filler|aesthetic|aesthetics|laser hair|skin clinic|sheesh[ -]?aesthetics|potenza)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Therapy / Mental Health", pattern: /\b(therapy|therapist|counseling|counselling|mental health|psychologist|psychiatrist)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Chiropractic", pattern: /\b(chiropractic|chiropractor|spine clinic)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Medical Clinic", pattern: /\b(health|medical|clinic|doctor|physician|urgent care|primary care|혈관센터|여성의학센터|인터벤션)\b/ },
  { industryCategory: "Legal", businessNiche: "Personal Injury Law", pattern: /\b(personal injury|injury lawyer|accident lawyer|car accident|truck accident)\b/ },
  { industryCategory: "Legal", businessNiche: "Family / Divorce Law", pattern: /\b(divorce|family law|custody|child support)\b/ },
  { industryCategory: "Legal", businessNiche: "Immigration Law", pattern: /\b(immigration|visa attorney|green card|citizenship)\b/ },
  { industryCategory: "Legal", businessNiche: "Law Firm", pattern: /\b(law firm|lawyer|attorney|legal services|litigation)\b/ },
  { industryCategory: "Retail", businessNiche: "Eyewear / Optical Retail", pattern: /\b(optical|eyeglasses?|glasses frames?|prescription glasses|sunglasses|contact lenses?)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Baby Products Retail", pattern: /\b(baby carrier|baby carriers|kinnbaby|stroller|baby wrap|infant carrier)\b/ },
  { industryCategory: "Education", businessNiche: "Language School", pattern: /\b(language school|spanish school|spaans leren|apprendre l'espagnol|learn spanish|linguaschools?)\b/ },
  { industryCategory: "Local Services", businessNiche: "Barbershop / Hair Salon", pattern: /\b(barber|barbearia|barbershop|hair salon|haircut|peluquer[ií]a)\b/ },
  { industryCategory: "Local Services", businessNiche: "Martial Arts / Fitness", pattern: /\b(martial arts|gracie|jiu[- ]?jitsu|bjj|karate|taekwondo)\b/ },
  { industryCategory: "Logistics / Transportation", businessNiche: "Group Transport / Minibus", pattern: /\b(minibus|group transport|charter bus|bus charter|airport transfer)\b/ },
  { industryCategory: "Home Services", businessNiche: "Flooring", pattern: /\b(flooring|vloeren|vloertechniek|pvc vloeren|epoxy floors?|floor coating)\b/ },
  { industryCategory: "Home Services", businessNiche: "Painting", pattern: /\b(painting|painter|commercial painting|residential painting)\b/ },
  { industryCategory: "Home Services", businessNiche: "Retaining Walls / Drainage", pattern: /\b(retaining walls?|seawall|drainage|hardscape construction)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Osteopathy / Physical Therapy", pattern: /\b(osteopath|osteopathy|physical therapy|physiotherapy|rehab clinic)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Home Care / Elder Care", pattern: /\b(îngrijire bătrâni|ingrijire batrani|elder care|home care|caregivers?|aged care)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Pet Products Retail", pattern: /\b(pet products?|pet supplies|buttercup pet|dog treats?|cat toys?)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Spices / Food Retail", pattern: /\b(spices?|kruiden|kruidenmengsels|seasoning|chef spices)\b/ },
  { industryCategory: "B2B Services", businessNiche: "Virtual Office / Business Address", pattern: /\b(geschäftsadresse|geschaeftsadresse|business address|virtual office|registered office)\b/ },
  { industryCategory: "B2B Services", businessNiche: "Reputation / Content Removal", pattern: /\b(remove leaked content|leaked content|content removal|reputation management|unexpose)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "AdTech / Media Buying Platform", pattern: /\b(media buying platform|xmp|cross-channel|adtech|mobvista)\b/ },
  { industryCategory: "Education", businessNiche: "Legal Exam Coaching", pattern: /\b(upsc law|law optional coaching|law coaching|legal exam)\b/ },
  { industryCategory: "Mobile Apps", businessNiche: "AI Photo App", pattern: /\b(ai family photo|photo studio|ai photo|pixreunion)\b/ },
  { industryCategory: "Gaming", businessNiche: "Poker Software", pattern: /\b(poker hand analysis|ai poker|x-poker|deepfold)\b/ },
  { industryCategory: "Home Services", businessNiche: "Doors / Windows", pattern: /\b(windows and doors|window replacement|door replacement|yorkwindowsanddoors|york windows|вхідні двері|межк[іи]мнатн[іи]|межкомнатн[іи]|dvere|drzwi|deuren|fenster)\b/ },
  { industryCategory: "Home Services", businessNiche: "Plumbing", pattern: /\b(plumb(?:er|ing)?|drain cleaning|water heater)\b/ },
  { industryCategory: "Home Services", businessNiche: "HVAC", pattern: /\b(hvac|heating|air conditioning|furnace|heat pump)\b/ },
  { industryCategory: "Home Services", businessNiche: "Roofing", pattern: /\b(roof|roofer|roofing|gutter)\b/ },
  { industryCategory: "Home Services", businessNiche: "Remodeling / Contracting", pattern: /\b(remodel|renovation|contractor|construction|home builder)\b/ },
  { industryCategory: "Home Services", businessNiche: "Electrical", pattern: /\b(electrician|electrical|ev charger)\b/ },
  { industryCategory: "Home Services", businessNiche: "Landscaping / Lawn Care", pattern: /\b(landscap|lawn care|tree service|tree specialists?|arborist|hardscape)\b/ },
  { industryCategory: "Home Services", businessNiche: "Cleaning", pattern: /\b(cleaning|maid service|house cleaning|janitorial|carpet cleaning|кл[іи]н[іи]нг)\b/ },
  { industryCategory: "Home Services", businessNiche: "Pest Control", pattern: /\b(pest|exterminator|termite|rodent|dezinsekciya|дезинсекц|дезінсекц|蜂駆除)\b/ },
  { industryCategory: "Home Services", businessNiche: "Junk Removal", pattern: /\b(junk removal|rubbish removal|trash removal|waste removal|вывоз мусора|вив[іi]з см[іi]ття|стар[іи] мебл[іи])\b/ },
  { industryCategory: "Home Services", businessNiche: "Tub Refinishing", pattern: /\b(tub refinishing|bathtub refinishing|bathtub reglaz|tub reglaz|goprotubrefinishing)\b/ },
  { industryCategory: "Home Services", businessNiche: "Appliance Repair", pattern: /\b(appliance repair|kitchen repair|residential kitchen repair|profix\.expert)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Apparel / Fashion Retail", pattern: /\b(apparel|fashion|clothing|shoes|jewelry)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Online Retail / Store", pattern: /\b(ecommerce|e-commerce|online shop|shopify|webshop|buy online|online retail|shopping ads?)\b/ },
  { industryCategory: "Real Estate", businessNiche: "Real Estate Agent / Brokerage", pattern: /\b(real estate|realtor|brokerage|homes for sale|property agent)\b/ },
  { industryCategory: "Real Estate", businessNiche: "Property Management / Apartments", pattern: /\b(property management|apartments?|rentals?|leasing)\b/ },
  { industryCategory: "Education", businessNiche: "Courses / Training", pattern: /\b(course|academy|training|certification|bootcamp)\b/ },
  { industryCategory: "Education", businessNiche: "School / Tutoring", pattern: /\b(education|school|tutor|tutoring|learning center)\b/ },
  { industryCategory: "Education", businessNiche: "Driving School", pattern: /\b(driving school|drivingschool|driving lesson|driving teacher|운전학원|운전선생)\b/ },
  { industryCategory: "Travel / Hospitality", businessNiche: "Pet Travel / Transport", pattern: /\b(pet travel|pet shipping|pet transport|animal transport|pets4jet)\b/ },
  { industryCategory: "Travel / Hospitality", businessNiche: "Hotel / Lodging", pattern: /\b(hotel|lodging|resort|hospitality|vacation rental)\b/ },
  { industryCategory: "Travel / Hospitality", businessNiche: "Tours / Travel", pattern: /\b(travel|tour|flight|vacation|tourism|expeditions?)\b/ },
  { industryCategory: "Legal", businessNiche: "Immigration / Golden Visa", pattern: /\b(golden visa|citizenship by descent|qualified investor program|qiv|qip|sponsor licence|visa extension|ilr|green card|portugal visa|greece visa|panama visa)\b/ },
  { industryCategory: "Automotive", businessNiche: "Parking / Car Rental", pattern: /\b(parking|rent a car|car rental|airport parking|lpr|กล้องอ่านป้ายทะเบียน)\b/ },
  { industryCategory: "Automotive", businessNiche: "Electric Mobility / Scooters", pattern: /\b(elektro roller|electric scooter|seniorenmobile|mobility scooter)\b/ },
  { industryCategory: "Travel / Hospitality", businessNiche: "Tours / River Cruise", pattern: /\b(river cruise|boat tour|saigon boat|boat company|dinner cruise|private yacht|yacht|waterz|cruise campaign)\b/ },
  { industryCategory: "Local Services", businessNiche: "Restaurant / Food Service", pattern: /\b(restaurant|cafe|pizza|barbecue|bbq|food truck|catering)\b/ },
  { industryCategory: "Local Services", businessNiche: "Fitness / Gym", pattern: /\b(airlockbjj|fitness|gym|personal trainer|pilates|yoga|crossfit|bjj|jiu[- ]?jitsu|martial arts)\b/ },
  { industryCategory: "Local Services", businessNiche: "Salon / Spa", pattern: /\b(salon|spa|hair|nails|massage|cold plunge|wellness)\b|spa\./ },
  { industryCategory: "Local Services", businessNiche: "Child Daycare", pattern: /\b(child daycare|daycare|preschool|child care|childcare|missmarias|miss maria|now enrolling|summer enrollment|fall classes)\b/ },
  { industryCategory: "Local Services", businessNiche: "Escape Room / Entertainment", pattern: /\b(escape room|arcade|entertainment center)\b/ },
  { industryCategory: "Local Services", businessNiche: "Fingerprinting / Licensing", pattern: /\b(fingerprinting|business licensing|licensing & consulting)\b/ },
  { industryCategory: "Local Services", businessNiche: "Wedding / Event Services", pattern: /\b(wedding leads?|parkwed|central park wedding|event planning|wedding planner)\b/ },
  { industryCategory: "Local Services", businessNiche: "Party / Bounce House Rentals", pattern: /\b(bounce house|moonbounce|toothemoonbounce|party rentals?|event rentals?)\b/ },
  { industryCategory: "Local Services", businessNiche: "Taxi / Car Service", pattern: /\b(cab me|cab service|taxi|airport transfer|routes search)\b/ },
  { industryCategory: "Travel / Hospitality", businessNiche: "Tours / River Cruise", pattern: /\b(river cruise|boat tour|saigon boat|boat company)\b/ },
];

const BROAD_INDUSTRY_RULES: BusinessNicheRule[] = [
  { industryCategory: "Dental", businessNiche: "Dental Practice", pattern: /\b(dental|dentist|orthodont|invisalign)\b/ },
  { industryCategory: "Healthcare", businessNiche: "Healthcare", pattern: /\b(health|medical|clinic|doctor|therapy|therapist|medspa|chiropractic)\b/ },
  { industryCategory: "Legal", businessNiche: "Legal Services", pattern: /\b(law|lawyer|attorney|legal|injury|divorce|immigration)\b/ },
  { industryCategory: "Home Services", businessNiche: "Home Services", pattern: /\b(plumb|hvac|roof|remodel|contractor|electrician|landscap|cleaning|pest)\b/ },
  { industryCategory: "Local Services", businessNiche: "Local Services", pattern: /\b(daycare|groom|boarding|salon|spa|restaurant|fitness|gym|pet|dog|veterinary|vet)\b/ },
  { industryCategory: "Ecommerce", businessNiche: "Ecommerce", pattern: /\b(ecommerce|e-commerce|online shop|shopify|webshop|online retail|buy online|shopping ads?)\b/ },
  { industryCategory: "B2B SaaS", businessNiche: "SaaS / Business Software", pattern: /\b(saas|software|platform|crm|api|automation|ai|mcp|agent|notfair|dochero)\b/ },
  { industryCategory: "Real Estate", businessNiche: "Real Estate", pattern: /\b(real estate|realtor|mortgage|property|apartments?)\b/ },
  { industryCategory: "Finance / Insurance", businessNiche: "Finance / Insurance", pattern: /\b(finance|insurance|bookkeeping|accounting|tax|loan|credit)\b/ },
  { industryCategory: "Education", businessNiche: "Education", pattern: /\b(education|school|course|academy|training|tutor)\b/ },
  { industryCategory: "Travel / Hospitality", businessNiche: "Travel / Hospitality", pattern: /\b(travel|hotel|hospitality|tour|flight|vacation)\b/ },
];

export function inferBusinessClassification(input: string): BusinessClassification {
  const text = input.toLowerCase().replace(/[_/|·—–-]+/g, " ");
  for (const rule of BUSINESS_NICHE_RULES) {
    if (rule.pattern.test(text)) return { industryCategory: rule.industryCategory, businessNiche: rule.businessNiche };
  }
  for (const rule of BROAD_INDUSTRY_RULES) {
    if (rule.pattern.test(text)) return { industryCategory: rule.industryCategory, businessNiche: rule.businessNiche };
  }
  return { industryCategory: "Other", businessNiche: "Other" };
}

async function fetchAccountContext(auth: AuthContext): Promise<AccountContext> {
  const customer = getCachedCustomer(auth);
  try {
    const rows = await customer.query(`
      SELECT
        customer.currency_code,
        customer.time_zone
      FROM customer
      LIMIT 1
    `) as AccountContextRow[];
    return {
      currencyCode: rows[0]?.customer?.currency_code ?? "UNKNOWN",
      timeZone: rows[0]?.customer?.time_zone ?? null,
    };
  } catch (error) {
    console.warn(`[benchmark-snapshots] Account context query failed for ${auth.customerId}:`, error);
    return { currencyCode: "UNKNOWN", timeZone: null };
  }
}

async function fetchBusinessContext(auth: AuthContext, seedText = ""): Promise<BusinessContext> {
  const customer = getCachedCustomer(auth);
  const finalUrls: string[] = [];
  const campaignNames: string[] = [];

  try {
    const rows = await customer.query(`
      SELECT
        campaign.name,
        ad_group_ad.ad.final_urls
      FROM ad_group_ad
      WHERE campaign.status != 'REMOVED'
        AND ad_group.status != 'REMOVED'
        AND ad_group_ad.status != 'REMOVED'
      LIMIT 25
    `) as FinalUrlRow[];

    finalUrls.push(...rows.flatMap((row) => row.ad_group_ad?.ad?.final_urls ?? []));
    campaignNames.push(...rows.map((row) => row.campaign?.name).filter((name): name is string => Boolean(name)));
  } catch (error) {
    console.warn(`[benchmark-snapshots] RSA business context query failed for ${auth.customerId}:`, error);
  }

  // PMax-only accounts have no ad_group_ad rows. Asset groups carry the final
  // URL signal we need for domain/industry enrichment.
  try {
    const rows = await customer.query(`
      SELECT
        campaign.name,
        asset_group.final_urls
      FROM asset_group
      WHERE campaign.status != 'REMOVED'
        AND asset_group.status != 'REMOVED'
      LIMIT 25
    `) as FinalUrlRow[];

    finalUrls.push(...rows.flatMap((row) => row.asset_group?.final_urls ?? []));
    campaignNames.push(...rows.map((row) => row.campaign?.name).filter((name): name is string => Boolean(name)));
  } catch (error) {
    console.warn(`[benchmark-snapshots] PMax business context query failed for ${auth.customerId}:`, error);
  }

  const businessDomain = finalUrls.map(parseDomain).find((domain): domain is string => !!domain) ?? null;
  const classification = inferBusinessClassification(`${seedText} ${businessDomain ?? ""} ${campaignNames.join(" ")}`);
  return { businessDomain, ...classification };
}

async function fetchCampaignTargeting(auth: AuthContext) {
  const customer = getCachedCustomer(auth);
  const byCampaign = new Map<string, CampaignTargeting>();

  try {
    const rows = await customer.query(`
      SELECT
        campaign.id,
        campaign_criterion.type,
        campaign_criterion.negative,
        campaign_criterion.location.geo_target_constant,
        campaign_criterion.language.language_constant
      FROM campaign_criterion
      WHERE campaign.status != 'REMOVED'
        AND campaign_criterion.status != 'REMOVED'
      LIMIT 20000
    `) as CampaignCriterionRow[];

    for (const row of rows) {
      const campaignId = row.campaign?.id;
      if (campaignId == null) continue;
      const targeting = getOrCreateTargeting(byCampaign, String(campaignId));
      const type = normalizeEnum(row.campaign_criterion?.type);
      const isNegative = Boolean(row.campaign_criterion?.negative);
      const geoTarget = row.campaign_criterion?.location?.geo_target_constant;
      const language = row.campaign_criterion?.language?.language_constant;

      if (type?.includes("LOCATION") && geoTarget) {
        if (isNegative) targeting.negativeGeoTargetConstants.push(geoTarget);
        else targeting.geoTargetConstants.push(geoTarget);
      } else if (type?.includes("LANGUAGE") && language && !isNegative) {
        targeting.languageConstants.push(language);
      }
    }
  } catch (error) {
    console.warn(`[benchmark-snapshots] Campaign targeting query failed for ${auth.customerId}:`, error);
  }

  for (const targeting of byCampaign.values()) {
    targeting.geoTargetConstants = dedupeSorted(targeting.geoTargetConstants);
    targeting.negativeGeoTargetConstants = dedupeSorted(targeting.negativeGeoTargetConstants);
    targeting.languageConstants = dedupeSorted(targeting.languageConstants);
  }

  return byCampaign;
}

async function fetchAssetCoverage(auth: AuthContext, campaignIds: Set<string>) {
  const customer = getCachedCustomer(auth);
  const byCampaign = new Map<string, AssetCounts>();
  const customerLevelCounts = { ...EMPTY_ASSETS };

  try {
    const campaignRows = await customer.query(`
      SELECT
        campaign.id,
        campaign.status,
        campaign_asset.field_type,
        campaign_asset.status
      FROM campaign_asset
      WHERE campaign.status != 'REMOVED'
        AND campaign_asset.status = 'ENABLED'
    `) as AssetCoverageRow[];

    for (const row of campaignRows) {
      const campaignId = row.campaign?.id;
      if (campaignId == null) continue;
      const fieldType = row.campaign_asset?.field_type;
      const status = row.campaign_asset?.status;
      if (!isEnabled(status)) continue;
      assetCountsForType(getOrCreateAssetCounts(byCampaign, String(campaignId)), fieldType);
    }
  } catch (error) {
    console.warn(`[benchmark-snapshots] Campaign asset query failed for ${auth.customerId}:`, error);
  }

  try {
    const adGroupRows = await customer.query(`
      SELECT
        campaign.id,
        campaign.status,
        ad_group.status,
        ad_group_asset.field_type,
        ad_group_asset.status
      FROM ad_group_asset
      WHERE campaign.status != 'REMOVED'
        AND ad_group.status != 'REMOVED'
        AND ad_group_asset.status = 'ENABLED'
    `) as AssetCoverageRow[];

    for (const row of adGroupRows) {
      const campaignId = row.campaign?.id;
      if (campaignId == null) continue;
      const fieldType = row.ad_group_asset?.field_type;
      const status = row.ad_group_asset?.status;
      if (!isEnabled(status)) continue;
      assetCountsForType(getOrCreateAssetCounts(byCampaign, String(campaignId)), fieldType);
    }
  } catch (error) {
    console.warn(`[benchmark-snapshots] Ad group asset query failed for ${auth.customerId}:`, error);
  }

  try {
    const assetGroupRows = await customer.query(`
      SELECT
        campaign.id,
        campaign.status,
        asset_group.status,
        asset_group_asset.field_type,
        asset_group_asset.status
      FROM asset_group_asset
      WHERE campaign.status != 'REMOVED'
        AND asset_group.status != 'REMOVED'
        AND asset_group_asset.status = 'ENABLED'
    `) as AssetCoverageRow[];

    for (const row of assetGroupRows) {
      const campaignId = row.campaign?.id;
      if (campaignId == null) continue;
      const fieldType = row.asset_group_asset?.field_type;
      const status = row.asset_group_asset?.status;
      if (!isEnabled(status)) continue;
      assetCountsForType(getOrCreateAssetCounts(byCampaign, String(campaignId)), fieldType);
    }
  } catch (error) {
    console.warn(`[benchmark-snapshots] Asset group asset query failed for ${auth.customerId}:`, error);
  }

  try {
    const customerRows = await customer.query(`
      SELECT
        customer_asset.field_type,
        customer_asset.status
      FROM customer_asset
      WHERE customer_asset.status = 'ENABLED'
      LIMIT 1000
    `) as AssetCoverageRow[];

    for (const row of customerRows) {
      const fieldType = row.customer_asset?.field_type;
      const status = row.customer_asset?.status;
      if (!isEnabled(status)) continue;
      assetCountsForType(customerLevelCounts, fieldType);
    }
  } catch (error) {
    console.warn(`[benchmark-snapshots] Customer asset query failed for ${auth.customerId}:`, error);
  }

  for (const campaignId of campaignIds) {
    const counts = getOrCreateAssetCounts(byCampaign, campaignId);
    counts.sitelinkCount += customerLevelCounts.sitelinkCount;
    counts.calloutCount += customerLevelCounts.calloutCount;
    counts.structuredSnippetCount += customerLevelCounts.structuredSnippetCount;
    counts.imageAssetCount += customerLevelCounts.imageAssetCount;
  }

  return byCampaign;
}

async function fetchKeywordMix(auth: AuthContext, dateRange: DateRange) {
  const customer = getCachedCustomer(auth);
  const bySegment = new Map<string, KeywordMix>();

  try {
    const rows = await customer.query(`
      SELECT
        campaign.id,
        campaign.status,
        ad_group.status,
        ad_group_criterion.status,
        ad_group_criterion.negative,
        ad_group_criterion.keyword.match_type,
        segments.date,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value
      FROM keyword_view
      WHERE campaign.status != 'REMOVED'
        AND ad_group.status != 'REMOVED'
        AND ad_group_criterion.status != 'REMOVED'
        AND ad_group_criterion.negative = FALSE
        AND segments.date BETWEEN '${dateRange.start}' AND '${dateRange.end}'
    `) as KeywordMetricRow[];

    for (const row of rows) {
      const campaignId = row.campaign?.id;
      const snapshotDate = row.segments?.date;
      if (campaignId == null || !snapshotDate) continue;
      const matchType = normalizeEnum(row.ad_group_criterion?.keyword?.match_type);
      const mix = getOrCreateKeywordMix(bySegment, String(campaignId), snapshotDate);
      const impressions = metricNumber(row.metrics?.impressions);
      const clicks = metricNumber(row.metrics?.clicks);
      const costMicros = metricNumber(row.metrics?.cost_micros);
      const conversions = metricNumber(row.metrics?.conversions);
      const conversionsValue = metricNumber(row.metrics?.conversions_value);

      if (matchType?.includes("BROAD")) {
        mix.broadImpressions += impressions;
        mix.broadClicks += clicks;
        mix.broadCostMicros += costMicros;
        mix.broadConversions += conversions;
        mix.broadConversionsValue += conversionsValue;
      } else if (matchType?.includes("PHRASE")) {
        mix.phraseImpressions += impressions;
        mix.phraseClicks += clicks;
        mix.phraseCostMicros += costMicros;
        mix.phraseConversions += conversions;
        mix.phraseConversionsValue += conversionsValue;
      } else if (matchType?.includes("EXACT")) {
        mix.exactImpressions += impressions;
        mix.exactClicks += clicks;
        mix.exactCostMicros += costMicros;
        mix.exactConversions += conversions;
        mix.exactConversionsValue += conversionsValue;
      }
    }
  } catch (error) {
    console.warn(`[benchmark-snapshots] Keyword match-type query failed for ${auth.customerId}:`, error);
  }

  return bySegment;
}

async function fetchSearchCompetitiveMetrics(auth: AuthContext, dateRange: DateRange) {
  const customer = getCachedCustomer(auth);
  const byCampaignDateDevice = new Map<string, SearchCompetitiveMetrics>();

  try {
    const rows = await customer.query(`
      SELECT
        campaign.id,
        segments.date,
        metrics.search_impression_share,
        metrics.search_top_impression_share,
        metrics.search_absolute_top_impression_share,
        metrics.search_budget_lost_impression_share,
        metrics.search_rank_lost_impression_share
      FROM campaign
      WHERE campaign.status != 'REMOVED'
        AND campaign.advertising_channel_type IN ('SEARCH', 'PERFORMANCE_MAX')
        AND segments.date BETWEEN '${dateRange.start}' AND '${dateRange.end}'
      LIMIT 20000
    `) as SearchCompetitiveMetricRow[];

    for (const row of rows) {
      const campaignId = row.campaign?.id;
      const snapshotDate = row.segments?.date;
      if (campaignId == null || !snapshotDate) continue;
      byCampaignDateDevice.set(searchCompetitiveMapKey(String(campaignId), snapshotDate), {
        searchImpressionShare: nullableMetricNumber(row.metrics?.search_impression_share),
        searchTopImpressionShare: nullableMetricNumber(row.metrics?.search_top_impression_share),
        searchAbsoluteTopImpressionShare: nullableMetricNumber(row.metrics?.search_absolute_top_impression_share),
        searchBudgetLostImpressionShare: nullableMetricNumber(row.metrics?.search_budget_lost_impression_share),
        searchRankLostImpressionShare: nullableMetricNumber(row.metrics?.search_rank_lost_impression_share),
      });
    }
  } catch (error) {
    console.warn(`[benchmark-snapshots] Search competitive metric query failed for ${auth.customerId}:`, error);
  }

  return byCampaignDateDevice;
}

export async function collectCampaignTrafficBenchmarkSnapshots(
  auth: AuthContext,
  dateRange: DateRange,
  options: Pick<BenchmarkSyncOptions, "creditBudget" | "creditCounter"> = {},
  seedText = "",
) {
  const customer = getCachedCustomer(auth);
  const credits = createCreditTracker(options);
  credits.reserve(1);
  const metricRows = await customer.query(`
    SELECT
      customer.currency_code,
      customer.time_zone,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      AND segments.date BETWEEN '${dateRange.start}' AND '${dateRange.end}'
    ORDER BY segments.date DESC, metrics.impressions DESC
    LIMIT 20000
  `) as CampaignMetricRow[];

  const firstRow = metricRows[0];
  const campaignNameText = metricRows
    .map((row) => row.campaign?.name)
    .filter((name): name is string => Boolean(name))
    .join(" ");
  const classification = inferBusinessClassification(`${seedText} ${campaignNameText}`);

  return metricRows
    .map((row): CampaignBenchmarkSnapshot | null => {
      const campaignId = row.campaign?.id;
      const snapshotDate = row.segments?.date;
      if (campaignId == null || !snapshotDate) return null;

      return {
        accountId: auth.customerId,
        campaignId: String(campaignId),
        snapshotDate,
        adNetworkType: "ALL",
        device: "ALL",
        campaignName: row.campaign?.name ?? null,
        campaignStatus: normalizeEnum(row.campaign?.status, CAMPAIGN_STATUS_ENUM),
        advertisingChannelType: normalizeEnum(row.campaign?.advertising_channel_type, ADVERTISING_CHANNEL_TYPE_ENUM),
        biddingStrategyType: normalizeEnum(row.campaign?.bidding_strategy_type, BIDDING_STRATEGY_TYPE_ENUM),
        currencyCode: row.customer?.currency_code ?? firstRow?.customer?.currency_code ?? "UNKNOWN",
        timeZone: row.customer?.time_zone ?? firstRow?.customer?.time_zone ?? null,
        industryCategory: classification.industryCategory,
        businessNiche: classification.businessNiche,
        businessDomain: null,
        impressions: metricNumber(row.metrics?.impressions),
        clicks: metricNumber(row.metrics?.clicks),
        costMicros: metricNumber(row.metrics?.cost_micros),
        conversions: metricNumber(row.metrics?.conversions),
        conversionsValue: metricNumber(row.metrics?.conversions_value),
      };
    })
    .filter((row): row is CampaignBenchmarkSnapshot => row !== null);
}

export async function collectCampaignTrafficBenchmarkThirtyDaySnapshots(
  auth: AuthContext,
  dateRange: DateRange,
  options: Pick<BenchmarkSyncOptions, "creditBudget" | "creditCounter"> = {},
  seedText = "",
) {
  const customer = getCachedCustomer(auth);
  const credits = createCreditTracker(options);
  credits.reserve(1);
  const metricRows = await customer.query(`
    SELECT
      customer.currency_code,
      customer.time_zone,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      AND segments.date BETWEEN '${dateRange.start}' AND '${dateRange.end}'
    ORDER BY metrics.impressions DESC
    LIMIT 20000
  `) as CampaignMetricRow[];

  const firstRow = metricRows[0];
  const campaignNameText = metricRows
    .map((row) => row.campaign?.name)
    .filter((name): name is string => Boolean(name))
    .join(" ");
  const classification = inferBusinessClassification(`${seedText} ${campaignNameText}`);

  return metricRows
    .map((row): CampaignBenchmarkThirtyDaySnapshot | null => {
      const campaignId = row.campaign?.id;
      if (campaignId == null) return null;

      return {
        accountId: auth.customerId,
        campaignId: String(campaignId),
        snapshotAsOfDate: dateRange.end,
        windowStartDate: dateRange.start,
        windowEndDate: dateRange.end,
        windowDays: 30,
        observedDays: 30,
        adNetworkType: "ALL",
        device: "ALL",
        campaignName: row.campaign?.name ?? null,
        campaignStatus: normalizeEnum(row.campaign?.status, CAMPAIGN_STATUS_ENUM),
        advertisingChannelType: normalizeEnum(row.campaign?.advertising_channel_type, ADVERTISING_CHANNEL_TYPE_ENUM),
        biddingStrategyType: normalizeEnum(row.campaign?.bidding_strategy_type, BIDDING_STRATEGY_TYPE_ENUM),
        currencyCode: row.customer?.currency_code ?? firstRow?.customer?.currency_code ?? "UNKNOWN",
        timeZone: row.customer?.time_zone ?? firstRow?.customer?.time_zone ?? null,
        industryCategory: classification.industryCategory,
        businessNiche: classification.businessNiche,
        businessDomain: null,
        impressions: metricNumber(row.metrics?.impressions),
        clicks: metricNumber(row.metrics?.clicks),
        costMicros: metricNumber(row.metrics?.cost_micros),
        conversions: metricNumber(row.metrics?.conversions),
        conversionsValue: metricNumber(row.metrics?.conversions_value),
      };
    })
    .filter((row): row is CampaignBenchmarkThirtyDaySnapshot => row !== null);
}

export async function collectCampaignBenchmarkSnapshots(
  auth: AuthContext,
  dateRange: DateRange,
  options: Pick<BenchmarkSyncOptions, "creditBudget" | "creditCounter"> = {},
  seedText = "",
) {
  const credits = createCreditTracker(options);
  credits.reserve(7);
  const customer = getCachedCustomer(auth);
  const metricRows = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      segments.date,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE campaign.status != 'REMOVED'
      AND segments.date BETWEEN '${dateRange.start}' AND '${dateRange.end}'
    ORDER BY segments.date DESC, metrics.impressions DESC
    LIMIT 20000
  `) as CampaignMetricRow[];

  const campaignIds = new Set(
    metricRows
      .map((row) => row.campaign?.id)
      .filter((id): id is string | number => id != null)
      .map(String),
  );

  const [accountContext, businessContext, assetCoverage, keywordMix, competitiveMetrics, campaignTargeting] = await Promise.all([
    fetchAccountContext(auth),
    fetchBusinessContext(auth, seedText),
    fetchAssetCoverage(auth, campaignIds),
    fetchKeywordMix(auth, dateRange),
    fetchSearchCompetitiveMetrics(auth, dateRange),
    fetchCampaignTargeting(auth),
  ]);

  return metricRows
    .map((row): CampaignBenchmarkSnapshot | null => {
      const campaignId = row.campaign?.id;
      const snapshotDate = row.segments?.date;
      if (campaignId == null || !snapshotDate) return null;

      const campaignIdText = String(campaignId);
      const adNetworkType = "ALL";
      const device = "ALL";
      const assets = assetCoverage.get(assetMapKey(campaignIdText)) ?? EMPTY_ASSETS;
      const keywords = keywordMix.get(segmentMapKey(campaignIdText, snapshotDate)) ?? EMPTY_KEYWORD_MIX;
      const competitive = competitiveMetrics.get(searchCompetitiveMapKey(campaignIdText, snapshotDate)) ?? EMPTY_COMPETITIVE;
      const targeting = campaignTargeting.get(campaignIdText) ?? EMPTY_TARGETING;

      return {
        accountId: auth.customerId,
        campaignId: campaignIdText,
        snapshotDate,
        adNetworkType,
        device,
        campaignName: row.campaign?.name ?? null,
        campaignStatus: normalizeEnum(row.campaign?.status, CAMPAIGN_STATUS_ENUM),
        advertisingChannelType: normalizeEnum(row.campaign?.advertising_channel_type, ADVERTISING_CHANNEL_TYPE_ENUM),
        biddingStrategyType: normalizeEnum(row.campaign?.bidding_strategy_type, BIDDING_STRATEGY_TYPE_ENUM),
        currencyCode: accountContext.currencyCode,
        timeZone: accountContext.timeZone,
        industryCategory: businessContext.industryCategory,
        businessNiche: businessContext.businessNiche,
        businessDomain: businessContext.businessDomain,
        geoTargetCount: targeting.geoTargetConstants.length,
        negativeGeoTargetCount: targeting.negativeGeoTargetConstants.length,
        languageTargetCount: targeting.languageConstants.length,
        geoTargetConstants: targeting.geoTargetConstants,
        languageConstants: targeting.languageConstants,
        impressions: metricNumber(row.metrics?.impressions),
        clicks: metricNumber(row.metrics?.clicks),
        costMicros: metricNumber(row.metrics?.cost_micros),
        conversions: metricNumber(row.metrics?.conversions),
        conversionsValue: metricNumber(row.metrics?.conversions_value),
        searchImpressionShare: competitive.searchImpressionShare,
        searchTopImpressionShare: competitive.searchTopImpressionShare,
        searchAbsoluteTopImpressionShare: competitive.searchAbsoluteTopImpressionShare,
        searchBudgetLostImpressionShare: competitive.searchBudgetLostImpressionShare,
        searchRankLostImpressionShare: competitive.searchRankLostImpressionShare,
        hasSitelinks: assets.sitelinkCount > 0,
        sitelinkCount: assets.sitelinkCount,
        hasCallouts: assets.calloutCount > 0,
        calloutCount: assets.calloutCount,
        hasStructuredSnippets: assets.structuredSnippetCount > 0,
        structuredSnippetCount: assets.structuredSnippetCount,
        hasImageAssets: assets.imageAssetCount > 0,
        imageAssetCount: assets.imageAssetCount,
        keywordBroadImpressions: keywords.broadImpressions,
        keywordBroadClicks: keywords.broadClicks,
        keywordBroadCostMicros: keywords.broadCostMicros,
        keywordBroadConversions: keywords.broadConversions,
        keywordBroadConversionsValue: keywords.broadConversionsValue,
        keywordPhraseImpressions: keywords.phraseImpressions,
        keywordPhraseClicks: keywords.phraseClicks,
        keywordPhraseCostMicros: keywords.phraseCostMicros,
        keywordPhraseConversions: keywords.phraseConversions,
        keywordPhraseConversionsValue: keywords.phraseConversionsValue,
        keywordExactImpressions: keywords.exactImpressions,
        keywordExactClicks: keywords.exactClicks,
        keywordExactCostMicros: keywords.exactCostMicros,
        keywordExactConversions: keywords.exactConversions,
        keywordExactConversionsValue: keywords.exactConversionsValue,
      };
    })
    .filter((row): row is CampaignBenchmarkSnapshot => row !== null);
}

const BENCHMARK_UPSERT_CHUNK_SIZE = 1000;

export async function upsertCampaignBenchmarkThirtyDaySnapshots(rows: CampaignBenchmarkThirtyDaySnapshot[]) {
  if (rows.length === 0) return 0;

  for (let i = 0; i < rows.length; i += BENCHMARK_UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BENCHMARK_UPSERT_CHUNK_SIZE);
    await db()
      .insert(schema.campaignBenchmarkThirtyDaySnapshots)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          schema.campaignBenchmarkThirtyDaySnapshots.accountId,
          schema.campaignBenchmarkThirtyDaySnapshots.campaignId,
          schema.campaignBenchmarkThirtyDaySnapshots.snapshotAsOfDate,
        ],
        set: {
          windowStartDate: sqlExcluded("window_start_date"),
          windowEndDate: sqlExcluded("window_end_date"),
          windowDays: sqlExcluded("window_days"),
          observedDays: sqlExcluded("observed_days"),
          campaignName: sqlExcluded("campaign_name"),
          campaignStatus: sqlExcluded("campaign_status"),
          advertisingChannelType: sqlExcluded("advertising_channel_type"),
          biddingStrategyType: sqlExcluded("bidding_strategy_type"),
          adNetworkType: sqlExcluded("ad_network_type"),
          device: sqlExcluded("device"),
          currencyCode: sqlExcluded("currency_code"),
          timeZone: sqlExcluded("time_zone"),
          industryCategory: sqlExcluded("industry_category"),
          businessNiche: sqlExcluded("business_niche"),
          businessDomain: sqlExcluded("business_domain"),
          impressions: sqlExcluded("impressions"),
          clicks: sqlExcluded("clicks"),
          costMicros: sqlExcluded("cost_micros"),
          conversions: sqlExcluded("conversions"),
          conversionsValue: sqlExcluded("conversions_value"),
          updatedAt: sql.raw("now()"),
        },
      });
  }

  return rows.length;
}

export async function syncCampaignBenchmarkSnapshots(
  refreshToken: string,
  accounts: SnapshotAccountInput[],
  options: BenchmarkSyncOptions = {},
) {
  const dateRange = options.dateRange ?? getDateRangeEndingYesterday(options.days ?? 30);
  const creditCounter = options.creditCounter ?? { used: 0, budget: options.creditBudget ?? null };
  if (options.creditBudget != null) creditCounter.budget = options.creditBudget;

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const { id, loginCustomerId, name } = normalizeSnapshotAccount(account);
      const auth: AuthContext = { refreshToken, customerId: id, loginCustomerId };
      const seedText = name ?? "";
      const rows = await collectCampaignTrafficBenchmarkThirtyDaySnapshots(auth, dateRange, { creditCounter }, seedText);
      return upsertCampaignBenchmarkThirtyDaySnapshots(rows);
    }),
  );

  let firstAccountError: unknown = null;
  const summary = results.reduce(
    (summary, result) => {
      summary.creditsUsed = creditCounter.used;
      summary.creditBudget = creditCounter.budget;
      if (result.status === "fulfilled") summary.rows += result.value;
      else if (result.reason instanceof BenchmarkCreditBudgetExceeded) summary.budgetExceeded = true;
      else {
        summary.errors += 1;
        firstAccountError ??= result.reason;
        console.warn("[benchmark-snapshots] Account benchmark sync failed:", result.reason);
      }
      return summary;
    },
    { rows: 0, errors: 0, creditsUsed: creditCounter.used, creditBudget: creditCounter.budget, budgetExceeded: false },
  );

  if (options.throwOnAccountError && firstAccountError) {
    throw firstAccountError;
  }

  return summary;
}

function sqlExcluded(columnName: string) {
  // Local helper keeps this file independent of Drizzle's generated table SQL
  // aliases while still producing stable ON CONFLICT DO UPDATE assignments.
  return sql.raw(`excluded.${columnName}`);
}
