/**
 * `/monitor_settings` command and TUI panel for pi-cc-monitor.
 */

import { numberSettingValue, store, type PiCcConfig } from "./config.ts";
import { createPluginSettings, type PanelTheme, type SettingsPanel, type SettingsPanelOptions as GenericPanelOptions } from "./plugin-settings.ts";
export type { PanelTheme, SettingsPanel };
export type SettingsPanelOptions = GenericPanelOptions<keyof PiCcConfig>;

export const CONFIG_CHANNEL = "pi-cc-monitor:config";

export const { settingsPanel, registerSettingsCommand } = createPluginSettings<PiCcConfig>({
	command: "monitor_settings",
	title: "Monitor",
	channel: CONFIG_CHANNEL,
	store,
	usageHint: "Usage: /monitor_settings <item> <value>  (messages/footer: on|off; retention: days; logs/budget: MiB)",
	specs: [
		{
			field: "compactMessages",
			label: "Message style",
			on: "compact",
			off: "card",
			description: "How Monitor events are drawn. compact: one collapsed line, expandable details; card: the legacy padded card.",
		},
		{
			field: "footer",
			label: "Footer summary",
			on: "on",
			off: "off",
			description: "One line in Pi's footer while monitors run: 2 monitors.",
		},
		{
			field: "logRetentionDays",
			label: "Artifact retention",
			choices: [1, 3, 7, 14, 30],
			unit: "d",
			parse: (value) => numberSettingValue("logRetentionDays", value),
			description: "Keep ended observation log copies for this many days. Pending results, live resources and the 10-minute read grace are protected.",
		},
		{
			field: "logMaxMiB",
			label: "Task log limit",
			choices: [1, 5, 10, 20, 50, 100],
			unit: " MiB",
			applyNote: " (new tasks)",
			parse: (value) => numberSettingValue("logMaxMiB", value),
			description: "Observation copy limit per task, including rotation archives. Applies to newly started observations; old output is discarded with a visible truncation flag.",
		},
		{
			field: "logBudgetMiB",
			label: "Artifact budget",
			choices: [50, 100, 200, 500, 1000],
			unit: " MiB",
			parse: (value) => numberSettingValue("logBudgetMiB", value),
			description: "Soft disk budget for safely collectible observation copies. Oldest ended data goes first; protected data may temporarily exceed the budget.",
		},
	],
	keys: {
		messages: "compactMessages",
		message: "compactMessages",
		footer: "footer",
		status: "footer",
		statusline: "footer",
		retention: "logRetentionDays",
		logs: "logMaxMiB",
		logmax: "logMaxMiB",
		budget: "logBudgetMiB",
	},
});
