/**
 * Data Maskit - Privacy Shield Engine: Rules & Validators
 *
 * Upstream Reference Repository:
 * https://github.com/xiaYuTian11/maskit
 *
 * Upstream source references for rules and default configurations:
 * - transparent.py: https://github.com/xiaYuTian11/maskit/blob/master/engine/transparent.py
 * - shield_defaults.py: https://github.com/xiaYuTian11/maskit/blob/master/engine/shield_defaults.py
 *
 * Ported from Maskit (GNU AGPL-3.0) to native TypeScript for pi-ai-manager.
 */

export const UPSTREAM_MASKIT_REPO = "https://github.com/xiaYuTian11/maskit";
export const UPSTREAM_MASKIT_TRANSPARENT_URL = "https://raw.githubusercontent.com/xiaYuTian11/maskit/master/engine/transparent.py";
export const UPSTREAM_MASKIT_DEFAULTS_URL = "https://raw.githubusercontent.com/xiaYuTian11/maskit/master/engine/shield_defaults.py";

export interface BuiltinRuleDef {
	label: string;
	regex: RegExp;
	captureGroup: number;
	mayHitMarkers?: readonly string[];
}

export type BuiltinRuleLabel =
	| "PRIVATE_KEY"
	| "API_KEY"
	| "ACCESS_KEY"
	| "JWT"
	| "TOKEN"
	| "SECRET"
	| "CONNSTR"
	| "PHONE"
	| "EMAIL"
	| "LANDLINE"
	| "PLATE"
	| "HKID"
	| "IDCARD"
	| "IP_PRIVATE"
	| "IP_INTERNAL"
	| "CARD"
	| "IBAN"
	| "USCC"
	| "MAC";

export const DEFAULT_BUILTIN_RULES: Record<BuiltinRuleLabel, boolean> = {
	PRIVATE_KEY: true,
	CONNSTR: true,
	PHONE: true,
	EMAIL: true,
	LANDLINE: true,
	PLATE: true,
	HKID: false,
	IDCARD: true,
	IP_PRIVATE: true,
	IP_INTERNAL: false,
	CARD: true,
	IBAN: true,
	USCC: false,
	MAC: false,
	API_KEY: true,
	ACCESS_KEY: true,
	JWT: true,
	TOKEN: true,
	SECRET: true,
};

export const CREDENTIAL_LABELS = new Set<string>([
	"PRIVATE_KEY",
	"API_KEY",
	"ACCESS_KEY",
	"JWT",
	"TOKEN",
	"SECRET",
	"CONNSTR",
]);

export const DEFAULT_SECRET_PREFIXES = ["sk-", "ah-", "ghp_", "gho_", "xoxb-", "xoxp-"];

// Boundary definitions
const ID_BOUND_L = "(?<![A-Za-z0-9])";
const ID_BOUND_R = "(?![A-Za-z0-9])";
const IP_BOUND_R = "(?![A-Za-z0-9]|\\.\\d)";

export const BUILTIN_RULES: readonly BuiltinRuleDef[] = [
	// 1. PEM Private Key
	{
		label: "PRIVATE_KEY",
		regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]{20,}?-----END[^-]*PRIVATE KEY-----/g,
		captureGroup: 0,
		mayHitMarkers: ["PRIVATE KEY"],
	},
	// 2. GitHub Token (ghp, gho, ghu, ghs, ghr)
	{
		label: "API_KEY",
		regex: /(?<![A-Za-z0-9_-])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_-])/g,
		captureGroup: 0,
		mayHitMarkers: ["gh"],
	},
	// 3. GitHub fine-grained PAT
	{
		label: "API_KEY",
		regex: /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9_-])/g,
		captureGroup: 0,
		mayHitMarkers: ["github_pat_"],
	},
	// 4. Google API Key
	{
		label: "API_KEY",
		regex: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35,38}(?![A-Za-z0-9_-])/g,
		captureGroup: 0,
		mayHitMarkers: ["AIza"],
	},
	// 5. Aliyun AccessKey
	{
		label: "ACCESS_KEY",
		regex: /(?<![A-Za-z0-9_-])LTAI[A-Za-z0-9]{12,20}(?![A-Za-z0-9_-])/g,
		captureGroup: 0,
		mayHitMarkers: ["LTAI"],
	},
	// 6. Tencent Cloud SecretId (AKID)
	{
		label: "ACCESS_KEY",
		regex: /(?<![A-Za-z0-9_-])AKID[A-Za-z0-9]{13,32}(?![A-Za-z0-9_-])/g,
		captureGroup: 0,
		mayHitMarkers: ["AKID"],
	},
	// 7. Slack Token
	{
		label: "API_KEY",
		regex: /(?<![A-Za-z0-9_-])xox[baprs]-[0-9A-Za-z-]{10,}(?![A-Za-z0-9-])/g,
		captureGroup: 0,
		mayHitMarkers: ["xox"],
	},
	// 8. Stripe Key
	{
		label: "API_KEY",
		regex: /(?<![A-Za-z0-9_-])[sr]k_(?:live|test)_[0-9A-Za-z]{20,}(?![A-Za-z0-9])/g,
		captureGroup: 0,
		mayHitMarkers: ["sk_", "rk_"],
	},
	// 9. Feishu / DingTalk app keys
	{
		label: "API_KEY",
		regex: /(?<![A-Za-z0-9_-])cli_[a-z0-9]{16,}(?![a-z0-9])/g,
		captureGroup: 0,
		mayHitMarkers: ["cli_"],
	},
	{
		label: "API_KEY",
		regex: /(?<![A-Za-z0-9_-])ding[a-z0-9]{6,}(?![a-z0-9])/g,
		captureGroup: 0,
		mayHitMarkers: ["ding"],
	},
	// 10. AWS AccessKey ID
	{
		label: "ACCESS_KEY",
		regex: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
		captureGroup: 0,
		mayHitMarkers: ["AKIA", "ASIA"],
	},
	// 11. AWS SecretAccessKey (key=value pattern)
	{
		label: "ACCESS_KEY",
		regex: /aws[_-]?secret[_-]?access[_-]?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
		captureGroup: 1,
		mayHitMarkers: ["aws", "AWS"],
	},
	// 12. JWT
	{
		label: "JWT",
		regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
		captureGroup: 0,
		mayHitMarkers: ["eyJ"],
	},
	// 13. Bearer Token
	{
		label: "TOKEN",
		regex: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/gi,
		captureGroup: 1,
		mayHitMarkers: ["Bearer", "bearer"],
	},
	// 14. Password / Secret keyword assignments (CJK + English, quotes handled)
	{
		label: "SECRET",
		regex: new RegExp(
			"(?:(?<![A-Za-z0-9_.])(?:password|passwd|pwd|secret(?:[_-]?key)?|token|api[_-]?key|access[_-]?key|private[_-]?key)(?![A-Za-z0-9_.])" +
			"|(?:密码|口令|令牌|密钥|秘钥|密匙|凭据|凭证|私钥|授权码|访问密钥|接口密钥))" +
			"[\"'“”「」]?\\s*[:=：＝]\\s*[\"'“”「」]?(?!/)" +
			"(?=[A-Za-z0-9!@#$%^&*_~+=-]*[0-9!@#$%^&*])" +
			"([A-Za-z0-9!@#$%^&*_~+=-]{6,64})(?![A-Za-z0-9!@#$%^&*_~+=-])",
			"gi"
		),
		captureGroup: 1,
		mayHitMarkers: ["=", ":", "：", "＝"],
	},
	// 15. DB Connection string password
	{
		label: "CONNSTR",
		regex: /\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s:@/]+:([^\s@/]{4,})@/gi,
		captureGroup: 1,
		mayHitMarkers: ["://"],
	},
	// 16. Mobile Phone (China +86, 0086, grouped)
	{
		label: "PHONE",
		regex: new RegExp(
			ID_BOUND_L +
			"(?:(?:\\+?86|0086|[\\(（]\\+?86[\\)）])[\\s-]?)?1[3-9]\\d(?:([-\\s])\\d{4}\\1\\d{4}|\\d{8})" +
			ID_BOUND_R,
			"g"
		),
		captureGroup: 0,
		mayHitMarkers: ["1"],
	},
	// 17. Email
	{
		label: "EMAIL",
		regex: /(?<!:)(?<![A-Za-z0-9._\u4e00-\u9fff])[a-zA-Z0-9_\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9._%+-]{0,63}@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z\u4e00-\u9fff]{2,}(?![A-Za-z0-9._%+-])/g,
		captureGroup: 0,
		mayHitMarkers: ["@"],
	},
	// 18. Landline Phone
	{
		label: "LANDLINE",
		regex: new RegExp(
			ID_BOUND_L +
			"(?:(?:\\+?86|0086|[\\(（]\\+?86[\\)）])[\\s-]?)?" +
			"(?:" +
			  "[\\(（]0(?:10|2\\d|[3-9]\\d{2})[\\)）][\\s-]?[2-9]\\d{6,7}" +
			  "|" +
			  "0(?:10|2\\d|[3-9]\\d{2})[-\\s][2-9]\\d{6,7}" +
			")" +
			"(?:[-\\s]?(?:转|分机|ext|x|#)[-\\s]?\\d{1,5})?" +
			ID_BOUND_R,
			"gi"
		),
		captureGroup: 0,
		mayHitMarkers: ["0"],
	},
	// 19. Chinese Vehicle License Plate (must contain at least one digit)
	{
		label: "PLATE",
		regex: /(?<![A-Za-z0-9])[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼使领][A-Z](?=[A-Z0-9]{0,5}\d)[A-Z0-9]{5,6}(?![A-Z0-9])/g,
		captureGroup: 0,
	},
	// 20. Hong Kong ID card (H followed by 8 digits)
	{
		label: "HKID",
		regex: new RegExp(ID_BOUND_L + "H\\d{8}" + ID_BOUND_R, "g"),
		captureGroup: 0,
		mayHitMarkers: ["H"],
	},
	// 21. Chinese ID Card 15 & 18 digits
	{
		label: "IDCARD",
		regex: new RegExp(ID_BOUND_L + "(?:1[1-5]|2[1-3]|3[1-7]|4[1-6]|5[0-4]|6[1-5]|71|8[12])\\d{13}" + ID_BOUND_R, "g"),
		captureGroup: 0,
	},
	{
		label: "IDCARD",
		regex: new RegExp(ID_BOUND_L + "(?:1[1-5]|2[1-3]|3[1-7]|4[1-6]|5[0-4]|6[1-5]|71|8[12])\\d{15}[\\dXx]" + ID_BOUND_R, "g"),
		captureGroup: 0,
	},
	// 22. Private IP (192.168.x.x, 169.254.x.x, CGNAT 100.64-127.x.x)
	{
		label: "IP_PRIVATE",
		regex: new RegExp(
			ID_BOUND_L +
			"(?:192\\.168\\.\\d{1,3}\\.\\d{1,3}|169\\.254\\.\\d{1,3}\\.\\d{1,3}|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3})" +
			IP_BOUND_R,
			"g"
		),
		captureGroup: 0,
		mayHitMarkers: ["192.", "169.", "100."],
	},
	// 23. Internal IP (10.x.x.x, 172.16-31.x.x - default disabled)
	{
		label: "IP_INTERNAL",
		regex: new RegExp(
			ID_BOUND_L +
			"(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})" +
			IP_BOUND_R,
			"g"
		),
		captureGroup: 0,
		mayHitMarkers: ["10.", "172."],
	},
	// 24. Credit Card (13-19 digits, Luhn check)
	{
		label: "CARD",
		regex: new RegExp(
			ID_BOUND_L +
			"(?:[3-6]\\d{12,18}|[3-6]\\d{2,5}(?:([ -])\\d{1,6}){1,4})" +
			ID_BOUND_R,
			"g"
		),
		captureGroup: 0,
	},
	// 25. IBAN
	{
		label: "IBAN",
		regex: new RegExp(ID_BOUND_L + "[A-Z]{2}\\d{2}[A-Z0-9]{11,30}" + ID_BOUND_R, "g"),
		captureGroup: 0,
	},
	// 26. Unified Social Credit Code (USCC)
	{
		label: "USCC",
		regex: new RegExp(ID_BOUND_L + "[0-9A-HJ-NPQRTUWXY]{2}\\d{6}[0-9A-HJ-NPQRTUWXY]{10}" + ID_BOUND_R, "g"),
		captureGroup: 0,
	},
	// 27. MAC Address
	{
		label: "MAC",
		regex: /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])/g,
		captureGroup: 0,
	},
];

// --- Validation Functions ---

const PROVINCES = new Set([
	"11", "12", "13", "14", "15",
	"21", "22", "23",
	"31", "32", "33", "34", "35", "36", "37",
	"41", "42", "43", "44", "45", "46",
	"50", "51", "52", "53", "54",
	"61", "62", "63", "64", "65",
	"71", "81", "82",
]);

const IDCARD_W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const IDCARD_CODE = "10X98765432";

export function isIdCard18Valid(num: string): boolean {
	if (typeof num !== "string" || num.length !== 18 || !/^\d{17}$/.test(num.slice(0, 17))) {
		return false;
	}
	if (!PROVINCES.has(num.slice(0, 2))) return false;
	const y = parseInt(num.slice(6, 10), 10);
	const m = parseInt(num.slice(10, 12), 10);
	const d = parseInt(num.slice(12, 14), 10);
	if (m < 1 || m > 12 || d < 1 || d > 31) return false;
	const birth = new Date(y, m - 1, d);
	if (birth.getFullYear() !== y || birth.getMonth() !== m - 1 || birth.getDate() !== d) return false;
	const nowYear = new Date().getFullYear();
	if (y < 1880 || y > nowYear) return false;

	let total = 0;
	for (let i = 0; i < 17; i++) {
		total += parseInt(num[i]!, 10) * IDCARD_W[i]!;
	}
	const expected = IDCARD_CODE[total % 11];
	return num[17]!.toUpperCase() === expected;
}

export function isIdCard15Valid(num: string): boolean {
	if (typeof num !== "string" || num.length !== 15 || !/^\d{15}$/.test(num)) {
		return false;
	}
	if (!PROVINCES.has(num.slice(0, 2))) return false;
	const yy = parseInt(num.slice(6, 8), 10);
	const mm = parseInt(num.slice(8, 10), 10);
	const dd = parseInt(num.slice(10, 12), 10);
	const y = 1900 + yy;
	if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
	const birth = new Date(y, mm - 1, dd);
	return birth.getFullYear() === y && birth.getMonth() === mm - 1 && birth.getDate() === dd;
}

export function isIdCardValid(num: string): boolean {
	if (num.length === 18) return isIdCard18Valid(num);
	if (num.length === 15) return isIdCard15Valid(num);
	return false;
}

export function isPhoneValid(numStr: string): boolean {
	let digits = numStr.replace(/\D/g, "");
	if (digits.startsWith("86") && digits.length === 13) {
		digits = digits.slice(2);
	} else if (digits.startsWith("0086") && digits.length === 15) {
		digits = digits.slice(4);
	}
	if (digits.length !== 11) return false;
	if (digits[0] !== "1" || !"3456789".includes(digits[1]!)) return false;
	if (new Set(digits).size === 1) return false;
	return true;
}

export function isLuhnValid(numStr: string): boolean {
	const digits = numStr.replace(/\D/g, "").split("").map((c) => parseInt(c, 10));
	if (digits.length < 12) return false;
	let sum = 0;
	let dbl = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits[i]!;
		if (dbl) {
			d = d * 2 > 9 ? d * 2 - 9 : d * 2;
		}
		sum += d;
		dbl = !dbl;
	}
	return sum % 10 === 0;
}

export function isCardValid(numStr: string): boolean {
	const digits = numStr.replace(/[ -]/g, "");
	if (!/^\d+$/.test(digits) || digits.length < 13 || digits.length > 19) {
		return false;
	}
	return isLuhnValid(digits);
}

export function isIbanValid(iban: string): boolean {
	const s = iban.trim();
	if (s.length < 15 || !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) {
		return false;
	}
	const reordered = s.slice(4) + s.slice(0, 4);
	let digits = "";
	for (const c of reordered) {
		if (/[A-Z]/.test(c)) {
			digits += String(c.charCodeAt(0) - 55);
		} else {
			digits += c;
		}
	}
	try {
		return BigInt(digits) % 97n === 1n;
	} catch {
		return false;
	}
}

export function isJwtValid(token: string): boolean {
	try {
		const head = token.split(".")[0];
		if (!head) return false;
		const pad = "=".repeat((-head.length % 4 + 4) % 4);
		const base64 = (head + pad).replace(/-/g, "+").replace(/_/g, "/");
		const decoded = Buffer.from(base64, "base64").toString("utf-8");
		return decoded.includes('"alg"');
	} catch {
		return false;
	}
}

export function isEmailValid(emailStr: string): boolean {
	const s = emailStr.trim();
	if (!s.includes("@") || s.startsWith("@") || s.endsWith("@")) return false;
	const parts = s.split("@");
	if (parts.length !== 2) return false;
	const [local, domain] = parts as [string, string];
	if (local.length < 1 || domain.length < 3 || !domain.includes(".")) return false;
	if (local.startsWith(".") || local.endsWith(".") || local.includes("..") || domain.includes("..")) {
		return false;
	}
	const tld = domain.split(".").pop();
	return !!(tld && tld.length >= 2);
}

const CONNSTR_TPL_RXS = [
	/^\$?\{[A-Za-z_][A-Za-z0-9_]*\}$/,
	/^<[A-Za-z_][A-Za-z0-9_]*>$/,
	/^\[[A-Za-z_][A-Za-z0-9_]*\]$/,
	/^\$[A-Za-z_][A-Za-z0-9_]*$/,
	/^%[A-Za-z_][A-Za-z0-9_]*%$/,
];
const CONNSTR_WILDCARD_RX = /^[xX*.]+$/;

export function isConnStrPasswordValid(orig: string): boolean {
	if (!orig) return false;
	if (CONNSTR_WILDCARD_RX.test(orig)) return false;
	if (CONNSTR_TPL_RXS.some((rx) => rx.test(orig))) return false;
	return true;
}

export function ruleMayHit(text: string, rule: BuiltinRuleDef): boolean {
	if (!rule.mayHitMarkers || rule.mayHitMarkers.length === 0) return true;
	for (const marker of rule.mayHitMarkers) {
		if (text.includes(marker)) return true;
	}
	return false;
}
