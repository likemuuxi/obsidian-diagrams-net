import { addIcon, Editor, MarkdownView, Notice, Plugin, TAbstractFile, TFile, Vault, Workspace, Menu, MenuItem } from 'obsidian';
import { normalizePath } from 'obsidian'
import { ICON } from './constants';
import DiagramsView from './diagrams-view';
import { DEFAULT_SETTINGS, DiagramsSettings, DiagramsSettingsTab } from "./settings";

export default class DiagramsNet extends Plugin {

	vault: Vault;
	workspace: Workspace;
	diagramsView: DiagramsView;
	ui: string;
	settings: DiagramsSettings;

	async onload() {
		this.vault = this.app.vault;
		this.workspace = this.app.workspace;

		await this.loadSettings();
		this.addSettingTab(new DiagramsSettingsTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('css-change', () => {
				this.handleThemeChange();
			})
		);

		this.handleThemeChange();

		this.registerDomEvent(document, 'dblclick', (evt: MouseEvent) => {
			let target = evt.target as HTMLElement;
			if (target.tagName === "IMG" && target.parentElement?.classList.contains("internal-embed")) {
				target = target.parentElement;
			}
			if (target.classList.contains("internal-embed")) {
				const src = target.getAttribute("src");
				if (src && src.endsWith(".svg")) {
					const file = this.app.metadataCache.getFirstLinkpathDest(src, "");
					if (file instanceof TFile) {
						this.attemptEditDiagram(file);
					}
				}
			}
		});

		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			if (!evt.altKey) return; // 只在按住 Alt 键时处理
		
			let target = evt.target as HTMLElement;
			if (target.tagName === "IMG" && target.parentElement?.classList.contains("internal-embed")) {
				target = target.parentElement;
			}
			if (target.classList.contains("internal-embed")) {
				const src = target.getAttribute("src");
				if (src && src.endsWith(".svg")) {
					const file = this.app.metadataCache.getFirstLinkpathDest(src, "");
					if (file instanceof TFile) {
						this.attemptEditDiagram(file);
						// evt.preventDefault(); // 阻止默认行为
					}
				}
			}
		});

		addIcon("diagram", ICON);

		this.addCommand({
			id: 'app:diagrams-net-new-diagram',
			name: 'New diagram',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					if (!checking) {
						this.attemptNewDiagram()
					}
					return true;
				}
				return false;
			},
			hotkeys: []
		});


		// this.addRibbonIcon("diagram", "Insert new diagram", () => this.attemptNewDiagram() );

		// this.registerEvent(
		// 	this.app.workspace.on("file-menu", this.handleFileMenu, this)
		// );

		// this.registerEvent(
		// 	this.app.workspace.on("editor-menu", this.handleEditorMenu, this)
		// );


		this.registerEvent(this.app.vault.on('rename', (file, oldname) => this.handleRenameFile(file, oldname)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.handleDeleteFile(file)));

	}

	handleThemeChange() {
		const isDarkMode = document.body.classList.contains('theme-dark');
		this.ui = isDarkMode ? '&ui=dark' : '&ui=min';
	}

	isFileValidDiagram(file: TAbstractFile) {
		let itIs = false
		if (file instanceof TFile && file.extension === 'svg') {
			const xmlFile = this.app.vault.getAbstractFileByPath(this.getXmlPath(file.path));
			if (xmlFile && xmlFile instanceof TFile && xmlFile.extension === 'xml') {
				itIs = true
			}
		}
		return itIs
	}

	getXmlPath(path: string) {
		return path.endsWith('.svg') ? path.slice(0, -4) + '.xml' : path + '.xml';
	}

	activeLeafPath(workspace: Workspace) {
		const view = workspace.getActiveViewOfType(MarkdownView);
		return view?.getState().file;
	}

	activeLeafName(workspace: Workspace) {
		return workspace.getActiveViewOfType(MarkdownView)?.getDisplayText();
	}

	async availablePath() {
		let basePath: string;
		
		// 确保路径格式正确
		switch (this.settings.defaultLocation) {
			case 'default':
				// @ts-ignore: Type not documented.
				basePath = await this.vault.getAvailablePathForAttachments('Diagram', 'svg', this.workspace.getActiveFile())
				break;
			case 'current':
				// 当前文件路径
				const activeFile = this.workspace.getActiveFile();
				if (activeFile) {
					const folderPath = activeFile.parent.path;  // 获取当前文件夹路径
					basePath = await this.getAvailablePath('Diagram', 'svg', folderPath);
				} else {
					throw new Error('No active file found for the current location setting.');
				}
				break;
			case 'custom':
				// 自定义路径
				const customPath = this.settings.customPath || '';
				if (!customPath.trim()) {
					throw new Error('Custom path setting is empty. Please specify a valid path.');
				}
				// @ts-ignore: Type not documented.
				const folderPath = normalizePath(customPath);
				// 路径检查
				const folder = this.app.vault.getFolderByPath(folderPath);
				if (!folder) {
					new Notice("The path setting does not exist");
					throw new Error(`The specified custom path does not exist: ${folderPath}`);
				}
				basePath = await this.getAvailablePath('Diagram', 'svg', folderPath);
				break;
			default:
				throw new Error('Invalid default location setting.');
		}
	
		return {
			svgPath: basePath,
			xmlPath: this.getXmlPath(basePath),
		};
	}
	
	async getAvailablePath(filename: string, extension: string, folderPath?: string): Promise<string> {
		const path = folderPath ? folderPath : this.vault.configDir;
		let basePath = `${path}/${filename}.${extension}`;
		
		// 这里检查文件是否已经存在
		let counter = 1;
		while (await this.vault.adapter.exists(basePath)) {
			basePath = `${path}/${filename} (${counter}).${extension}`;
			counter++;
		}
		
		return basePath;
	}
	

	async attemptNewDiagram() {
		const { svgPath, xmlPath } = await this.availablePath()
		const fileInfo = {
			path: this.activeLeafPath(this.workspace),
			basename: this.activeLeafName(this.workspace),
			diagramExists: false,
			svgPath,
			xmlPath
		};
		this.initView(fileInfo);
	}


	attemptEditDiagram(svgFile: TFile) {
		if (!this.isFileValidDiagram(svgFile)) {
			new Notice('Diagram is not valid. (Missing .xml data)');
		}
		else {
			const fileInfo = {
				path: this.activeLeafPath(this.workspace),
				basename: this.activeLeafName(this.workspace),
				svgPath: svgFile.path,
				xmlPath: this.getXmlPath(svgFile.path),
				diagramExists: true,
			};
			this.initView(fileInfo);
		}
	}

	async initView(fileInfo: any) {
		const hostView = this.workspace.getActiveViewOfType(MarkdownView);
		new DiagramsView(this.app, hostView, fileInfo, this.ui, this.settings).open();
	}

	handleDeleteFile(file: TAbstractFile) {
		if (this.isFileValidDiagram(file)) {
			const xmlFile = this.app.vault.getAbstractFileByPath(this.getXmlPath(file.path));
			this.vault.delete(xmlFile)
		}
	}

	handleRenameFile(file: TAbstractFile, oldname: string) {
		if (file instanceof TFile && file.extension === 'svg') {
			const xmlFile = this.app.vault.getAbstractFileByPath(this.getXmlPath(oldname));
			if (xmlFile && xmlFile instanceof TFile && xmlFile.extension === 'xml') {
				this.vault.rename(xmlFile, this.getXmlPath(file.path))
			}
		}
	}

	handleFileMenu(menu: Menu, file: TAbstractFile) {
		if (file instanceof TFile && file.extension === 'svg') {
			menu.addItem((item) => {
				item
					.setTitle("Edit diagram")
					.setIcon("diagram")
					.onClick(async () => {
						this.attemptEditDiagram(file);
					});
			});
		}
	}

	handleEditorMenu(menu: Menu, editor: Editor, view: MarkdownView) {
		menu.addItem((item: MenuItem) => {
			item
				.setTitle("Insert new diagram")
				.setIcon("diagram")
				.onClick(async () => {
					this.attemptNewDiagram();
				});
		});
	}

	async onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

}


