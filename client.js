window.__ModuleLoader__.load({
	id: "dsh-alioss-backup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var react = require("react");
		var h = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useCallback = react.useCallback;

		var NS = "dsh-alioss-backup-settings";
		var CONFIG_URL = "/plugins/alioss-backup/config?format=json";
		var BUNDLE_KEY = "dsh-alioss-backup";

		var FALLBACK = {
			title: "阿里云 OSS 备份",
			description: "把 DSH 的数据、插件、工作区和部署配置备份到阿里云 OSS。",
			endpoint: "Endpoint",
			region: "Region",
			bucket: "Bucket",
			prefix: "Prefix",
			keepDays: "保留天数",
			autoBackupHour: "自动备份（-1 关闭，0-23 点）",
			accessKeyId: "AccessKey ID",
			accessKeySecret: "AccessKey Secret",
			keepSecret: "已配置，留空不修改",
			notConfigured: "未配置",
			configured: "已配置",
			save: "保存配置",
			saving: "保存中…",
			test: "测试连接",
			testing: "测试中…",
			backup: "立即备份",
			backingUp: "备份中…",
			configFile: "配置文件",
			credentialsFile: "凭证文件",
			hint: "保存后手动工具立即生效；自动备份时间修改后需重启 DSH。",
			loadFailed: "读取配置失败",
			actionFailed: "操作失败",
			loading: "加载中…",
			wireUnavailable: "配置接口不可用。",
		};

		function fieldStyle() {
			return { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 };
		}
		var labelStyle = { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary, #bbb)" };
		var inputStyle = {
			boxSizing: "border-box",
			width: "100%",
			height: 34,
			padding: "0 12px",
			fontSize: 13,
			color: "var(--dsw-alias-label-primary, #eee)",
			background: "var(--dsw-alias-bg-layer-1, #111)",
			border: "1px solid var(--dsw-alias-border-l2, #444)",
			borderRadius: 8,
		};
		var buttonStyle = {
			font: "inherit",
			fontSize: 13,
			padding: "6px 14px",
			borderRadius: 8,
			cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l2, #444)",
			background: "transparent",
			color: "var(--dsw-alias-label-primary, #eee)",
		};
		var primaryStyle = Object.assign({}, buttonStyle, {
			background: "var(--dsw-alias-label-primary, #eee)",
			color: "var(--dsw-alias-bg-layer-1, #111)",
		});
		var badgeStyle = function (configured) {
			return {
				fontSize: 11,
				padding: "1px 8px",
				borderRadius: 999,
				color: configured ? "var(--dsw-alias-label-secondary, #bbb)" : "var(--dsw-alias-label-tertiary, #888)",
				background: configured ? "var(--dsw-alias-bg-module-platform, #333)" : "transparent",
			};
		};
		var footerStyle = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", paddingTop: 12 };
		var hintStyle = { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)" };

		function Field(props) {
			return h("label", { style: fieldStyle() },
				h("span", { style: labelStyle }, props.label),
				h("input", {
					style: inputStyle,
					value: props.value,
					type: props.type || "text",
					autoComplete: props.autoComplete || "off",
					placeholder: props.placeholder || "",
					disabled: props.disabled,
					onChange: (event) => props.onChange(event.target.value),
				}));
		}

		function SettingsPage(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return FALLBACK[key] || key; };
			var [state, setState] = useState({ status: "loading", settings: null, csrf: "", credentialsConfigured: false });
			var [accessKeyId, setAccessKeyId] = useState("");
			var [accessKeySecret, setAccessKeySecret] = useState("");
			var [busy, setBusy] = useState("");
			var [message, setMessage] = useState("");
			var [error, setError] = useState("");

			var load = useCallback(function () {
				setState(function (current) { return Object.assign({}, current, { status: "loading" }); });
				fetch(CONFIG_URL, { headers: { accept: "application/json" }, credentials: "same-origin" })
					.then(function (response) {
						if (!response.ok) throw new Error("HTTP " + response.status);
						return response.json();
					})
					.then(function (body) {
						if (!body || body.ok !== true) throw new Error(body && body.error ? body.error : "invalid response");
						setState({ status: "ready", settings: body.settings, csrf: body.csrf, credentialsConfigured: body.credentialsConfigured === true });
					})
					.catch(function (reason) {
						setError(reason instanceof Error ? reason.message : String(reason));
						setState(function (current) { return Object.assign({}, current, { status: "error" }); });
					});
			}, []);

			useEffect(function () { load(); }, [load]);

			var change = function (key, value) {
				setState(function (current) {
					if (!current.settings) return current;
					return Object.assign({}, current, { settings: Object.assign({}, current.settings, { [key]: value }) });
				});
				setMessage("");
				setError("");
			};

			var post = function (action) {
				if (!state.settings || busy) return;
				setBusy(action);
				setMessage("");
				setError("");
				var payload = Object.assign({}, state.settings, {
					csrf: state.csrf,
					action: action,
					accessKeyId: accessKeyId,
					accessKeySecret: accessKeySecret,
					endpoint: state.settings.endpoint,
					region: state.settings.region,
					bucket: state.settings.bucket,
					prefix: state.settings.prefix,
					keepDays: Number(state.settings.keepDays),
					autoBackupHour: Number(state.settings.autoBackupHour),
				});
				fetch(CONFIG_URL, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					credentials: "same-origin",
					body: JSON.stringify(payload),
				})
					.then(function (response) {
						return response.json().then(function (body) { return { response: response, body: body }; });
					})
					.then(function (result) {
						if (!result.response.ok || !result.body || result.body.ok !== true) {
							throw new Error(result.body && result.body.error ? result.body.error : "HTTP " + result.response.status);
						}
						setState({ status: "ready", settings: result.body.settings, csrf: result.body.csrf, credentialsConfigured: result.body.credentialsConfigured === true });
						setAccessKeyId("");
						setAccessKeySecret("");
						setMessage(result.body.message || "");
					})
					.catch(function (reason) {
						setError(reason instanceof Error ? reason.message : String(reason));
					})
					.finally(function () { setBusy(""); });
			};

			if (state.status === "loading") {
				return h("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
					h("li", { style: { padding: "14px 16px", fontSize: 13, color: "var(--dsw-alias-label-tertiary, #888)" } }, t("loading")));
			}
			if (state.status === "error" || !state.settings) {
				return h("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
					h("li", { style: { padding: "14px 16px", fontSize: 13, color: "var(--dsw-alias-state-error-primary, #ff6b6b)" } },
						(t("loadFailed") || "读取配置失败") + "：" + error));
			}

			var settings = state.settings;
			return h("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
				h("li", {
					style: {
						listStyle: "none",
						border: "1px solid var(--dsw-alias-border-l2, #333)",
						borderRadius: 12,
						background: "var(--dsw-alias-bg-layer-3, #1c1c1c)",
						padding: "16px",
						display: "flex",
						flexDirection: "column",
						gap: 12,
					},
				},
					h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
						h("div", { style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #eee)" } }, t("title")),
						h("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary, #888)" } }, t("description"))),
					h("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 } },
						h(Field, { label: t("endpoint"), value: settings.endpoint, disabled: !!busy, onChange: function (value) { change("endpoint", value); } }),
						h(Field, { label: t("region"), value: settings.region, disabled: !!busy, onChange: function (value) { change("region", value); } }),
						h(Field, { label: t("bucket"), value: settings.bucket, disabled: !!busy, onChange: function (value) { change("bucket", value); } }),
						h(Field, { label: t("prefix"), value: settings.prefix, disabled: !!busy, onChange: function (value) { change("prefix", value); } }),
						h(Field, { label: t("keepDays"), value: settings.keepDays, type: "number", disabled: !!busy, onChange: function (value) { change("keepDays", value); } }),
						h(Field, { label: t("autoBackupHour"), value: settings.autoBackupHour, type: "number", disabled: !!busy, onChange: function (value) { change("autoBackupHour", value); } })),
					h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						h("span", { style: { flex: 1, fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary, #eee)" } }, t("accessKeyId")),
						h("span", { style: badgeStyle(state.credentialsConfigured) }, state.credentialsConfigured ? t("configured") : t("notConfigured"))),
					h("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 } },
						h(Field, { label: t("accessKeyId"), value: accessKeyId, disabled: !!busy, placeholder: state.credentialsConfigured ? t("keepSecret") : "", onChange: setAccessKeyId }),
						h(Field, { label: t("accessKeySecret"), value: accessKeySecret, type: "password", disabled: !!busy, placeholder: state.credentialsConfigured ? t("keepSecret") : "", autoComplete: "new-password", onChange: setAccessKeySecret })),
					h("p", { style: hintStyle }, t("hint")),
					h("div", { style: { display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)" } },
						h("div", null, t("configFile") + "：" + settings.configFile),
						h("div", null, t("credentialsFile") + "：" + settings.credentialsFile)),
					message ? h("p", { role: "status", style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-secondary, #bbb)", whiteSpace: "pre-wrap" } }, message) : null,
					error ? h("p", { role: "alert", style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary, #ff6b6b)", whiteSpace: "pre-wrap" } }, error) : null,
					h("div", { style: footerStyle },
						h("button", { type: "button", style: primaryStyle, disabled: !!busy, onClick: function () { post("save"); } }, busy === "save" ? t("saving") : t("save")),
						h("button", { type: "button", style: buttonStyle, disabled: !!busy, onClick: function () { post("test"); } }, busy === "test" ? t("testing") : t("test")),
						h("button", { type: "button", style: buttonStyle, disabled: !!busy, onClick: function () { post("backup"); } }, busy === "backup" ? t("backingUp") : t("backup")))));
		}

		var inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(function () {
				var disposers = [];
				disposers.push(ctx.locale.register(NS, "zh", {
					title: "阿里云 OSS 备份",
					description: "把 DSH 的数据、插件、工作区和部署配置备份到阿里云 OSS。",
					endpoint: "Endpoint",
					region: "Region",
					bucket: "Bucket",
					prefix: "Prefix",
					keepDays: "保留天数",
					autoBackupHour: "自动备份（-1 关闭，0-23 点）",
					accessKeyId: "AccessKey ID",
					accessKeySecret: "AccessKey Secret",
					keepSecret: "已配置，留空不修改",
					notConfigured: "未配置",
					configured: "已配置",
					save: "保存配置",
					saving: "保存中…",
					test: "测试连接",
					testing: "测试中…",
					backup: "立即备份",
					backingUp: "备份中…",
					configFile: "配置文件",
					credentialsFile: "凭证文件",
					hint: "保存后手动工具立即生效；自动备份时间修改后需重启 DSH。",
					loadFailed: "读取配置失败",
					loading: "加载中…",
				}));
				return function () { disposers.forEach(function (dispose) { dispose(); }); };
			}, "alioss-backup: dictionaries");

			ctx.slots.inject("plugins.bundle.config", function* () {
				yield ctx.slots.register({
					name: "plugins.bundle.config",
					key: BUNDLE_KEY,
					locale: NS,
				}, SettingsPage);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
