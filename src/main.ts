import { addIcon, Editor, MarkdownView, Notice, normalizePath, Plugin, TAbstractFile, TFile, Vault, Workspace, Menu, MenuItem } from 'obsidian';
import { t } from './lang/helpers';
import { ICON } from './constants';
import DiagramsView from './diagrams-view';
import { DiagramsTabView, VIEW_TYPE_DIAGRAMS } from './diagrams-tab-view';
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

		// 捕获阶段监听，先于 Obsidian 核心（Alt+点击放大图片）执行；
		// 命中有效图表时阻断默认行为，避免同时打开放大预览
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			// 按住 Alt 键点击时编辑嵌入图表
			if (evt.altKey && this.handleEmbedClick(evt)) {
				evt.preventDefault();
				evt.stopPropagation();
			}
		}, { capture: true });

		addIcon("diagram", ICON);

		// 创建流：标签页编辑器视图（侧边栏"创建新图表"按钮打开）
		this.registerView(VIEW_TYPE_DIAGRAMS, (leaf) => new DiagramsTabView(leaf, this));

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

		this.addRibbonIcon("diagram", t('CREATE_NEW_DIAGRAM'), () => this.openDiagramTab());

		// 从当前笔记 / 选中文本生成图表（P7）：文本作为上下文预填 AI 面板
		this.addCommand({
			id: 'app:diagrams-net-diagram-from-note',
			name: t('COMMAND_DIAGRAM_FROM_NOTE'),
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) {
					if (!checking) {
						void this.diagramFromEditorText(view, view.editor);
					}
					return true;
				}
				return false;
			},
			hotkeys: []
		});

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
	// 返回是否命中有效图表：命中时由调用方阻止 Obsidian 默认行为（如 Alt+点击放大）
	handleEmbedClick(evt: MouseEvent): boolean {
		let target = evt.target as HTMLElement;
		if (target.tagName === "IMG") {
			const match = target.closest(".internal-embed");
			if (match) {
				target = match as HTMLElement;
			}
		}
		if (!target.classList || !target.classList.contains("internal-embed")) {
			return false;
		}
		const src = (target.getAttribute("src") || "").split('|')[0].split('#')[0].trim();
		if (src.toLowerCase().endsWith('.svg')) {
			const file = this.app.metadataCache.getFirstLinkpathDest(src, "");
			// 仅拦截有效图表；普通 svg 图片保留 Obsidian 原生 Alt+点击放大
			if (file instanceof TFile && this.isFileValidDiagram(file)) {
				this.attemptEditDiagram(file);
				return true;
			}
		}
		return false;
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


	async attemptNewDiagram(sourceText?: string) {
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
		this.initView(fileInfo, sourceText);
	}

	/** 创建流：在标签页中打开新图表编辑器；保存仅落盘，不插入当前笔记 */
	async openDiagramTab() {
		const paths = await this.availablePath();
		if (!paths || !paths.svgPath) {
			return;
		}
		const leaf = this.workspace.getLeaf(true);
		// 直接以带 state 的实例打开，不依赖 setViewState 的 setState 时序
		const view = new DiagramsTabView(leaf, this, {
			fileBasename: paths.svgPath.split('/').pop()?.slice(0, -4) ?? 'Diagram',
			svgPath: paths.svgPath,
			xmlPath: paths.xmlPath,
			diagramExists: false,
		});
		await leaf.open(view);
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

	initView(fileInfo: { basename: string, svgPath: string, xmlPath: string, diagramExists: boolean }, sourceText?: string) {
		const hostView = this.workspace.getActiveViewOfType(MarkdownView);
		new DiagramsView(this.app, hostView, fileInfo, this.ui, this.settings, this.manifest.dir,
			() => this.saveSettings(), sourceText).open();
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
		menu.addItem((item: MenuItem) => {
			item
				.setTitle(editor.somethingSelected() ? t('GENERATE_FROM_SELECTION') : t('GENERATE_FROM_NOTE'))
				.setIcon("diagram")
				.onClick(async () => {
					void this.diagramFromEditorText(view, editor);
				});
		});
	}

	/** 取选中文本（无选区取整篇笔记正文）作为上下文，新建图表并预填 AI 输入框 */
	async diagramFromEditorText(view: MarkdownView, editor?: Editor) {
		let text = '';
		if (editor && editor.somethingSelected()) {
			text = editor.getSelection();
		} else if (view.file) {
			text = await this.vault.cachedRead(view.file);
		}
		text = text.trim();
		if (!text) {
			new Notice(t('NOTE_TEXT_EMPTY'));
			return;
		}
		// 与喂给模型的图表 XML 同量级的长度上限，超出截断避免撑爆上下文
		if (text.length > 100_000) {
			text = text.slice(0, 100_000);
			new Notice(t('NOTE_TEXT_TRUNCATED'));
		}
		await this.attemptNewDiagram(t('AI_NOTE_PROMPT_PREFIX') + text);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		// 卸载时关闭所有图表编辑器标签页，避免残留未注册视图
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_DIAGRAMS);
	}

}
