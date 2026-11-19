import { App, PluginSettingTab, Setting } from "obsidian";
import DiagramsNet from "./main";
import { t } from "./lang/helpers"

//FileManager.renameFile() method
export interface DiagramsSettings {
	defaultLocation: string,
	customPath: string,
	createAndRename: boolean;
	embedUrl: string;
	aiEndpoint: string;
	aiModel: string;
	aiApiKey: string;
	/** 个人模板库（P10）：把当前画布 XML 以命名模板形式存进插件 data */
	customTemplates: Array<{ name: string; xml: string }>;
}

export const DEFAULT_SETTINGS: DiagramsSettings = {
	defaultLocation: 'default',
	customPath: '',
	createAndRename: true,
	embedUrl: 'https://embed.diagrams.net/',
	aiEndpoint: 'https://api.openai.com/v1',
	aiModel: 'gpt-4o',
	aiApiKey: '',
	customTemplates: [],
}

export class DiagramsSettingsTab extends PluginSettingTab {
	plugin: DiagramsNet;

	constructor(app: App, plugin: DiagramsNet) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		let textComponent: any;
		new Setting(containerEl)
			.setName(t('DEFAULT_LOCATION'))
			.addDropdown(async (dropdown) => {
				dropdown.addOption('default', t('DEFAULT_FOLDER'));
				dropdown.addOption('current', t('CURRENT_FOLDER'));
				dropdown.addOption('custom', t('CUSTOM_PATH'));
				dropdown.setValue(this.plugin.settings.defaultLocation || 'default');
				dropdown.onChange(async (value) => {
					this.plugin.settings.defaultLocation = value;
					textComponent.inputEl.style.display = value === 'custom' ? 'block' : 'none';
					await this.plugin.saveSettings();
				});
			})
			.addText(text => {
				textComponent = text
					.setPlaceholder('folder/subfolder')
					.setValue(this.plugin.settings.customPath || '')
					.onChange(async (value) => {
						this.plugin.settings.customPath = value;
						await this.plugin.saveSettings();
					});
				textComponent.inputEl.style.display = 
					this.plugin.settings.defaultLocation === 'custom' ? 'block' : 'none';
				return textComponent;
			});

            new Setting(containerEl)
			.setName(t("CREATE_AND_RENAME"))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.createAndRename)
				.onChange(async (value) => {
					this.plugin.settings.createAndRename = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("EMBED_URL"))
			.setDesc(DEFAULT_SETTINGS.embedUrl)
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.embedUrl)
				.setValue(this.plugin.settings.embedUrl || '')
				.onChange(async (value) => {
					this.plugin.settings.embedUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h3', { text: t('AI_SETTINGS') });

		new Setting(containerEl)
			.setName(t('AI_ENDPOINT'))
			.setDesc(t('AI_ENDPOINT_DESC'))
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.aiEndpoint)
				.setValue(this.plugin.settings.aiEndpoint || '')
				.onChange(async (value) => {
					this.plugin.settings.aiEndpoint = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('AI_MODEL'))
			.setDesc(t('AI_MODEL_DESC'))
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.aiModel)
				.setValue(this.plugin.settings.aiModel || '')
				.onChange(async (value) => {
					this.plugin.settings.aiModel = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('AI_API_KEY'))
			.addText(text => {
				text.inputEl.type = 'password';
				text.setValue(this.plugin.settings.aiApiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.aiApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}
}
