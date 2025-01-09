import { App, PluginSettingTab, Setting } from "obsidian";
import DiagramsNet from "./main";
import { t } from "./lang/helpers"

//FileManager.renameFile() method
export interface DiagramsSettings {
	defaultLocation: string,
	customPath: string,
	createAndRename: boolean;
}

export const DEFAULT_SETTINGS: DiagramsSettings = {
	defaultLocation: 'default',
	customPath: '',
	createAndRename: true,
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
			// .setDesc(t("Add hover button for accessibility functions in the modal window"))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.createAndRename)
				.onChange(async (value) => {
					this.plugin.settings.createAndRename = value;
					await this.plugin.saveSettings();
					await this.reloadPlugin();
				}));
	}

    async reloadPlugin() {
		await this.plugin.saveSettings();
		const app = this.plugin.app as any;
		await app.plugins.disablePlugin("obsidian-diagrams-net");
		await app.plugins.enablePlugin("obsidian-diagrams-net");
		app.setting.openTabById("obsidian-diagrams-net").display();
	}
}
