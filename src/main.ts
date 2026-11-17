import { addIcon, Editor, MarkdownView, Notice, normalizePath, Plugin, TAbstractFile, TFile, Vault, Workspace, Menu, MenuItem } from 'obsidian';
import { t } from './lang/helpers';
import { ICON } from './constants';
import DiagramsView from './diagrams-view';
import { DEFAULT_SETTINGS, DiagramsSettings, DiagramsSettingsTab } from "./settings";

export default class DiagramsNet extends Plugin {

	vault: Vault;
	workspace: Workspace;
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
			this.handleEmbedClick(evt);
		});

		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			// 按住 Alt 键点击时编辑嵌入图表
			if (evt.altKey) {
				this.handleEmbedClick(evt);
			}
		});

		addIcon("diagram", ICON);

		this.addCommand({
			id: 'app:diagrams-net-new-diagram',
			name: t('NEW_DIAGRAM'),
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

		this.addRibbonIcon("diagram", t('INSERT_NEW_DIAGRAM'), () => this.attemptNewDiagram() );

		this.registerEvent(
			this.app.workspace.on("file-menu", this.handleFileMenu, this)
		);

		this.registerEvent(
			this.app.workspace.on("editor-menu", this.handleEditorMenu, this)
		);

		this.registerEvent(this.app.vault.on('rename', (file, oldname) => this.handleRenameFile(file, oldname)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.handleDeleteFile(file)));

	}

	handleThemeChange() {
		const isDarkMode = document.body.classList.contains('theme-dark');
		this.ui = isDarkMode ? '&ui=min&dark=1' : '&ui=min';
	}

	// 处理笔记中嵌入图表的点击/双击编辑；src 可能带别名或子路径，如 diagram.svg|300
	handleEmbedClick(evt: MouseEvent) {
		let target = evt.target as HTMLElement;
		if (target.tagName === "IMG") {
			const match = target.closest(".internal-embed");
			if (match) {
				target = match as HTMLElement;
			}
		}
		if (!target.classList || !target.classList.contains("internal-embed")) {
			return;
		}
		const src = (target.getAttribute("src") || "").split('|')[0].split('#')[0].trim();
		if (src.toLowerCase().endsWith('.svg')) {
			const file = this.app.metadataCache.getFirstLinkpathDest(src, "");
			if (file instanceof TFile) {
				this.attemptEditDiagram(file);
			}
		}
	}

	isFileValidDiagram(file: TAbstractFile) {
		return file instanceof TFile
			&& file.extension === 'svg'
			&& this.app.vault.getAbstractFileByPath(this.getXmlPath(file.path)) instanceof TFile;
	}

	getXmlPath(path: string) {
		if (!path || !path.endsWith('.svg')) {
			return '';
		}
		const basePath = path.slice(0, -4);
		const xmlPath = basePath + '.xml';
		const legacyPath = basePath + '.svg.xml';
		// 统一使用 .xml；兼容旧版本在根目录生成的 .svg.xml
		if (this.app.vault.getAbstractFileByPath(xmlPath) instanceof TFile) {
			return xmlPath;
		}
		if (this.app.vault.getAbstractFileByPath(legacyPath) instanceof TFile) {
			return legacyPath;
		}
		return xmlPath;
	}

	async availablePath(): Promise<{ svgPath: string; xmlPath: string } | undefined> {
		let basePath: string;

		switch (this.settings.defaultLocation) {
			case 'default':
				// @ts-ignore: Type not documented.
				basePath = await this.vault.getAvailablePathForAttachments('Diagram', 'svg', this.workspace.getActiveFile())
				break;
			case 'current': {
				const activeFile = this.workspace.getActiveFile();
				if (!activeFile) {
					new Notice(t('NO_ACTIVE_FILE'));
					return;
				}
				basePath = await this.getAvailablePath('Diagram', 'svg', activeFile.parent?.path);
				break;
			}
			case 'custom': {
				const customPath = this.settings.customPath || '';
				if (!customPath.trim()) {
					new Notice(t('CUSTOM_PATH_EMPTY'));
					return;
				}
				const folderPath = normalizePath(customPath);
				const folder = customPath === '/' ? this.vault.getRoot() : this.app.vault.getFolderByPath(folderPath);
				if (!folder) {
					new Notice(`${t('CUSTOM_PATH_NOT_EXIST')}: ${folderPath}`);
					return;
				}
				basePath = await this.getAvailablePath('Diagram', 'svg', folderPath);
				break;
			}
			default:
				new Notice(t('INVALID_LOCATION_SETTING'));
				return;
		}

		if (!basePath) {
			return;
		}

		return {
			svgPath: basePath,
			xmlPath: this.getXmlPath(basePath),
		};
	}

	async getAvailablePath(filename: string, extension: string, folderPath?: string): Promise<string> {
		const path = folderPath ? folderPath : this.vault.configDir;
		let basePath;

		if (path == '/') {
			basePath = `${filename}.${extension}`;
		} else {
			basePath = `${path}/${filename}.${extension}`;
		}
		// 这里检查文件是否已经存在
		let counter = 1;
		while (await this.vault.adapter.exists(basePath)) {
			if (path == '/') {
				basePath = `${filename} (${counter}).${extension}`;
			} else {
				basePath = `${path}/${filename} (${counter}).${extension}`;
			}
			counter++;
		}
		return basePath;
	}


	async attemptNewDiagram() {
		const paths = await this.availablePath();
		if (!paths || !paths.svgPath) {
			return;
		}

		const fileInfo = {
			basename: this.workspace.getActiveViewOfType(MarkdownView)?.getDisplayText(),
			svgPath: paths.svgPath,
			xmlPath: paths.xmlPath,
			diagramExists: false
		};
		this.initView(fileInfo);
	}


	attemptEditDiagram(svgFile: TFile) {
		if (!this.isFileValidDiagram(svgFile)) {
			new Notice(t('DIAGRAM_INVALID'));
		} else {
			const fileInfo = {
				basename: this.workspace.getActiveViewOfType(MarkdownView)?.getDisplayText(),
				svgPath: svgFile.path,
				xmlPath: this.getXmlPath(svgFile.path),
				diagramExists: true,
			};
			this.initView(fileInfo);
		}
	}

	initView(fileInfo: { basename: string, svgPath: string, xmlPath: string, diagramExists: boolean }) {
		const hostView = this.workspace.getActiveViewOfType(MarkdownView);
		new DiagramsView(this.app, hostView, fileInfo, this.ui, this.settings).open();
	}

	handleDeleteFile(file: TAbstractFile) {
		if (this.isFileValidDiagram(file)) {
			const xmlFile = this.app.vault.getAbstractFileByPath(this.getXmlPath(file.path));
			if (xmlFile instanceof TFile) {
				this.vault.delete(xmlFile)
			}
		}
	}

	handleRenameFile(file: TAbstractFile, oldname: string) {
		if (file instanceof TFile && file.extension === 'svg') {
			const xmlFile = this.app.vault.getAbstractFileByPath(this.getXmlPath(oldname));
			if (xmlFile instanceof TFile && xmlFile.extension === 'xml') {
				this.vault.rename(xmlFile, this.getXmlPath(file.path))
			}
		}
	}

	handleFileMenu(menu: Menu, file: TAbstractFile) {
		if (file instanceof TFile && file.extension === 'svg') {
			menu.addItem((item) => {
				item
					.setTitle(t('EDIT_DIAGRAM'))
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
				.setTitle(t('INSERT_NEW_DIAGRAM'))
				.setIcon("diagram")
				.onClick(async () => {
					this.attemptNewDiagram();
				});
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

}
