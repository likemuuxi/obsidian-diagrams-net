/**
 * diagrams.net 嵌入编辑器（原生 DOM 实现）
 * - Based on: https://github.com/jgraph/drawio-integration
 * - https://desk.draw.io/support/solutions/articles/16000042544
 * - 通过 postMessage 与 embed.diagrams.net 的 iframe 通信
 */

const FRAME_ID = 'drawIoDiagramFrame';

// 默认嵌入地址（可在设置中替换为自托管 / 离线部署）
const DEFAULT_EMBED_URL = 'https://embed.diagrams.net/';

// 空白图的 base64 占位数据（首次新建时加载给编辑器）
const BLANK_DIAGRAM =
	'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB2ZXJzaW9uPSIxLjEiIHdpZHRoPSI5MXB4IiBoZWlnaHQ9IjYxcHgiIHZpZXdCb3g9Ii0wLjUgLTAuNSA5MSA2MSIgY29udGVudD0iJmx0O214ZmlsZSBldGFnPSZxdW90O255VDJrWi1zUFJUTzlwV2c0LU9XJnF1b3Q7IGFnZW50PSZxdW90OzUuMCAoTWFjaW50b3NoKSZxdW90OyBtb2RpZmllZD0mcXVvdDsyMDIwLTA2LTAzVDE1OjEwOjA1LjM0OFomcXVvdDsgaG9zdD0mcXVvdDt3d3cuZHJhdy5pbyZxdW90OyB2ZXJzaW9uPSZxdW90OzEzLjEuMTQmcXVvdDsmZ3Q7Jmx0O2RpYWdyYW0gaWQ9JnF1b3Q7clV1eHZtYW1kTloxenJsWE9sXzYmcXVvdDsgbmFtZT0mcXVvdDtQYWdlLTEmcXVvdDsmZ3Q7bFpOTGM0SXdFTWMvRFVkbUFyR1ZIcTFhKzVqV1RwMk9NOTRpV1VNNmdUQWhLdlRURjJURFk3ellFN3UvN0NQNzMrRFJlVnF1RE11VGQ4MUJlU0hocFVjWFhoZ0dFYVgxcHlGVlM2YlJ0QVhDU0k1QlBkaklYMEJJa0I0bGgySVVhTFZXVnVaakdPc3NnOWlPR0ROR244ZGhCNjNHWFhNbTRBcHNZcWF1NlZaeW03UTB1aU05ZndZcEV0YzVJSGlTTWhlTW9FZ1kxK2NCb2t1UHpvM1d0clhTY2c2cUVjL3A4aEY4TGlZaC9mS3pIWWxGT0Z2dWhQVGJZay8vU2VsR01KRFpXMHQvRjJEVys1OUcwcEFvdHEvWGVzbGNTQ1lNUzl1U3JtMTIzRS9zeXlrbzEyL2JWM3JRZWx2Ti9IN0c3cHFGclp5dVJoOHpEazArOGVpalVLd28wTzUwYXB3YnI0NGpuc0JZS0FlTHcvWXIwQ2xZVTlVaGVFcmRWdkJaUnVpUSt4MC9JRW9HNjcxSHh2QlZpYTV3cjF4dDRNRE9IV2pwVUwvMlMvamc1NkhMUHc9PSZsdDsvZGlhZ3JhbSZndDsmbHQ7L214ZmlsZSZndDsiPjxkZWZzLz48Zz48cmVjdCB4PSIwIiB5PSIwIiB3aWR0aD0iOTAiIGhlaWdodD0iNjAiIGZpbGw9IiNmZmZmZmYiIHN0cm9rZT0iIzAwMDAwMCIgcG9pbnRlci1ldmVudHM9ImFsbCIvPjxnIGZpbGw9IiMwMDAwMDAiIGZvbnQtZmFtaWx5PSJIZWx2ZXRpY2EiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtc2l6ZT0iMTJweCI+PHRleHQgeD0iNDQuNSIgeT0iMzQuNSI+RGlhZ3JhbTwvdGV4dD48L2c+PC9nPjwvc3ZnPg==';

export interface DiagramsEditorCallbacks {
	/** 导出 svg 完成（用户保存） */
	onSave: (msg: any) => void;
	/** 编辑器退出（不保存 / 点击关闭） */
	onExit: () => void;
	/** 读取已有图表数据（返回 xml 字符串，新建时返回空即可） */
	getData: () => string;
}

export class DiagramsEditor {
	private container: HTMLElement;
	private ui: string;
	private embedUrl: string;
	private targetOrigin: string;
	private callbacks: DiagramsEditorCallbacks;
	private frame: HTMLIFrameElement | null = null;
	private messageHandler: ((evt: MessageEvent) => void) | null = null;

	constructor(container: HTMLElement, ui: string, embedUrl: string, callbacks: DiagramsEditorCallbacks) {
		this.container = container;
		this.ui = ui;
		this.callbacks = callbacks;

		// 解析嵌入地址；无效时回退默认地址。targetOrigin 收紧到具体源，避免消息广播到任意页面
		let parsed: URL;
		try {
			parsed = new URL(embedUrl);
		}
		catch {
			parsed = new URL(DEFAULT_EMBED_URL);
		}
		if (!/^https?:$/.test(parsed.protocol)) {
			parsed = new URL(DEFAULT_EMBED_URL);
		}
		this.embedUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/`;
		this.targetOrigin = parsed.origin;
	}

	start() {
		if (!this.messageHandler) {
			this.messageHandler = this.handleMessageEvent.bind(this);
			window.addEventListener('message', this.messageHandler);
		}

		const url = `${this.embedUrl}?embed=1&proto=json&spin=1${this.ui}&libraries=1`;

		const frame = document.createElement('iframe');
		frame.id = FRAME_ID;
		frame.title = FRAME_ID;
		frame.src = url;
		frame.style.cssText =
			'width:100%;height:100%;left:0;top:0;border:none;z-index:10;background-color:white;';
		this.frame = frame;
		this.container.appendChild(frame);
	}

	stop() {
		if (this.messageHandler) {
			window.removeEventListener('message', this.messageHandler);
			this.messageHandler = null;
		}
		if (this.frame) {
			this.frame.remove();
			this.frame = null;
		}
	}

	private handleMessageEvent(evt: MessageEvent) {
		if (
			this.frame !== null &&
			evt.source === this.frame.contentWindow &&
			typeof evt.data === 'string' &&
			evt.data.length > 0
		) {
			try {
				const msg = JSON.parse(evt.data);
				if (msg != null) {
					this.handleMessage(msg);
				}
			}
			catch (e) {
				console.error(e);
			}
		}
	}

	private handleMessage(msg: any) {
		if (msg.event === 'init') {
			this.postMessage({
				action: 'load',
				noSaveBtn: 1,
				autosave: 0,
				saveAndExit: '1',
				modified: 'unsavedChanges',
				xml: this.callbacks.getData() || BLANK_DIAGRAM,
				title: 'Untitled',
			});
		}
		else if (msg.event === 'autosave') {
			// 忽略自动保存
		}
		else if (msg.event === 'save') {
			// 只导出 svg（png 导出从未被使用，白白增加保存耗时）
			this.postMessage({
				action: 'export',
				format: 'svg',
				embedImages: true,
				exit: msg.exit,
			});
		}
		else if (msg.event === 'export' && msg.format === 'svg') {
			this.callbacks.onSave(msg);
		}
		if (msg.event === 'exit') {
			this.callbacks.onExit();
		}
	}

	private postMessage(msg: any) {
		this.frame?.contentWindow?.postMessage(JSON.stringify(msg), this.targetOrigin);
	}
}
