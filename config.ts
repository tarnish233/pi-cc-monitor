/**
 * Independent settings for pi-cc-monitor (`pi-cc-monitor.json`, inheriting
 * valid keys from legacy `pi-cc.json` on first save unless `PI_CC_CONFIG_FILE` is set).
 */

import { createConfigStore, envBool, withFileLock } from "./plugin-settings.ts";
export { withFileLock };

export interface PiCcConfig {
	/** One-line notifications with expandable details instead of the legacy padded card. */
	compactMessages: boolean;
	/** Show this extension's summary in Pi's footer. */
	footer: boolean;
	/** Retention for ended, delivered task artifacts. */
	logRetentionDays: number;
	/** stdout + stderr, including their rotation archives; applies to new tasks. */
	logMaxMiB: number;
	/** Soft budget for safely collectible artifacts across local runtimes. */
	logBudgetMiB: number;
}

export const DEFAULT_CONFIG: PiCcConfig = {
	compactMessages: true,
	footer: true,
	logRetentionDays: 3,
	logMaxMiB: 20,
	logBudgetMiB: 200,
};

export const NUMBER_SETTINGS = {
	logRetentionDays: { min: 1, max: 30 },
	logMaxMiB: { min: 1, max: 1024 },
	logBudgetMiB: { min: 1, max: 10240 },
} as const;
export type NumberSetting = keyof typeof NUMBER_SETTINGS;

const ENV_OVERRIDES: Record<keyof PiCcConfig, string> = {
	compactMessages: "PI_CC_COMPACT_MESSAGES",
	footer: "PI_CC_FOOTER",
	logRetentionDays: "PI_MONITOR_LOG_RETENTION_DAYS",
	logMaxMiB: "PI_MONITOR_LOG_MAX_MIB",
	logBudgetMiB: "PI_MONITOR_LOG_BUDGET_MIB",
};

export function numberSettingValue(key: NumberSetting, value: unknown): number | undefined {
	const { min, max } = NUMBER_SETTINGS[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export const store = createConfigStore<PiCcConfig>({
	fileName: "pi-cc-monitor.json",
	defaults: DEFAULT_CONFIG,
	envOverrides: ENV_OVERRIDES,
	legacyKeys: ["compactMessages", "footer"],
	parseValue(key, raw, fromEnv) {
		if (key === "compactMessages" || key === "footer") {
			return (fromEnv ? envBool(ENV_OVERRIDES[key]) : typeof raw === "boolean" ? raw : undefined) as PiCcConfig[typeof key] | undefined;
		}
		if (fromEnv) {
			const trimmed = typeof raw === "string" ? raw.trim() : "";
			return (/^\d+$/.test(trimmed) ? numberSettingValue(key, Number(trimmed)) : undefined) as PiCcConfig[typeof key] | undefined;
		}
		return numberSettingValue(key, raw) as PiCcConfig[typeof key] | undefined;
	},
});

export const { configPath, envOverride, loadConfig, invalidateConfig, saveConfig } = store;
