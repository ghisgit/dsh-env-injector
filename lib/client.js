/*
 * dsh-env-injector — browser half. Built from src/client/** by scripts/build-client.mjs; do not edit.
 * sources-sha256:21e1e7d9bc624c3d3cbfefeac487469beefbcbf0ebb1b1fe2a912def81290f07
 * Modules requested: react, @deepseek-ai/dsh-client-ui-primitives, react/jsx-runtime
 */
window.__ModuleLoader__.load({
	id: "dsh-env-injector",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/card.tsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/contracts.ts
var CARD_FIELDS = ["rules", "overrideExisting", "terminal", "logMatches"];
var OPTION_FIELDS = ["overrideExisting", "terminal", "logMatches"];
var SCHEMA_FLOOR = {
  rules: [],
  overrideExisting: true,
  terminal: true,
  logMatches: false
};
var REGEXP_FLAGS = /^[dgimsuvy]*$/;
function compilesRegex(source, flags) {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}
function ruleIssue(rule) {
  if (rule.command.trim().length === 0) return "command";
  if (rule.envVar.trim().length === 0) return "envVar";
  if (!REGEXP_FLAGS.test(rule.flags) || new Set(rule.flags).size !== rule.flags.length) return "flags";
  if (!compilesRegex(rule.command, rule.flags)) return "regex";
  if (rule.argsPattern.trim().length > 0 && !compilesRegex(rule.argsPattern, rule.flags)) return "regex";
  return void 0;
}
function issueTarget(rule, issue) {
  if (issue !== "regex") return issue;
  return compilesRegex(rule.command, rule.flags) ? "argsPattern" : "command";
}
function newRule() {
  return { command: "", argsPattern: "", envVar: "", enabled: true, flags: "" };
}
function cloneRules(rules) {
  return rules.map((rule) => ({ ...rule }));
}
function sameRules(left, right) {
  if (left.length !== right.length) return false;
  return left.every((rule, index) => {
    const other = right[index];
    return other !== void 0 && rule.command === other.command && rule.argsPattern === other.argsPattern && rule.envVar === other.envVar && rule.enabled === other.enabled && rule.flags === other.flags;
  });
}
function sameFieldValue(field, left, right) {
  if (field === "rules") return sameRules(left, right);
  return left === right;
}

// src/client/locales.ts
var NS = "env-injector";
var en = {
  cardTitle: "Environment injection",
  cardDescription: "Rules that forward a harness-process variable into the child commands they match.",
  unsaved: "Unsaved",
  expand: "Expand",
  collapse: "Collapse",
  readOnly: "This deployment keeps settings in memory; the card is read-only.",
  save: "Save",
  saving: "Saving\u2026",
  discard: "Discard",
  saveFailed: "The save was refused. Your edits are still here.",
  overridden: "Overridden",
  reset: "Reset",
  layerHint: "Saving writes the user layer of the settings document; resetting a field makes it follow the deployment again.",
  rulesLabel: "Rules",
  rulesHint: "Each enabled rule whose command matches contributes its variable to that child only. Lists replace wholesale.",
  rulesEmpty: "No rules. This plugin injects nothing.",
  addRule: "Add rule",
  removeRule: "Remove",
  ruleCommand: "Command",
  ruleArgsPattern: "Arguments",
  ruleEnvVar: "Variable",
  ruleFlags: "Flags",
  ruleEnabled: "Enabled",
  ruleFieldLabel: "Rule {index} {field}",
  errorCommand: "A rule needs a command pattern; write .* to match every command.",
  errorEnvVar: "A rule needs a non-empty variable name.",
  errorFlags: "Not valid regular-expression flags.",
  errorRegex: "Not a valid regular expression.",
  optionOverrideExisting: "Override existing values",
  optionOverrideExistingHint: "The harness-process value replaces one the caller passed in the spawn spec.",
  optionTerminal: "Cover terminal sessions",
  optionTerminalHint: "Also apply the rules to spawnTerminal (PTY sessions); a persistent shell needs its rule on the shell itself.",
  optionLogMatches: "Log matches",
  optionLogMatchesHint: "One line per spawn (info) and per miss (debug), through the env-injector logger and stderr."
};
var zh = {
  cardTitle: "\u73AF\u5883\u53D8\u91CF\u6CE8\u5165",
  cardDescription: "\u6309\u89C4\u5219\u628A harness \u8FDB\u7A0B\u4E2D\u7684\u53D8\u91CF\u8F6C\u53D1\u7ED9\u5B83\u547D\u4E2D\u7684\u5B50\u547D\u4EE4\u3002",
  unsaved: "\u672A\u4FDD\u5B58",
  expand: "\u5C55\u5F00",
  collapse: "\u6536\u8D77",
  readOnly: "\u8BE5\u90E8\u7F72\u628A\u8BBE\u7F6E\u4FDD\u5B58\u5728\u5185\u5B58\u4E2D\uFF0C\u5361\u7247\u4E3A\u53EA\u8BFB\u3002",
  save: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  discard: "\u653E\u5F03",
  saveFailed: "\u4FDD\u5B58\u88AB\u62D2\u7EDD\uFF0C\u4F60\u7684\u4FEE\u6539\u4ECD\u7136\u4FDD\u7559\u3002",
  overridden: "\u5DF2\u8986\u76D6",
  reset: "\u91CD\u7F6E",
  layerHint: "\u4FDD\u5B58\u5199\u5165\u8BBE\u7F6E\u6587\u6863\u7684\u7528\u6237\u5C42\uFF1B\u91CD\u7F6E\u67D0\u5B57\u6BB5\u540E\uFF0C\u5B83\u5C06\u91CD\u65B0\u8DDF\u968F\u90E8\u7F72\u914D\u7F6E\u3002",
  rulesLabel: "\u89C4\u5219",
  rulesHint: "\u6BCF\u6761\u542F\u7528\u4E14\u547D\u4E2D\u547D\u4EE4\u7684\u89C4\u5219\uFF0C\u53EA\u628A\u5B83\u7684\u53D8\u91CF\u6CE8\u5165\u8BE5\u5B50\u8FDB\u7A0B\u3002\u5217\u8868\u662F\u6574\u4F53\u66FF\u6362\u3002",
  rulesEmpty: "\u6682\u65E0\u89C4\u5219\uFF0C\u672C\u63D2\u4EF6\u4E0D\u6CE8\u5165\u4EFB\u4F55\u53D8\u91CF\u3002",
  addRule: "\u6DFB\u52A0\u89C4\u5219",
  removeRule: "\u5220\u9664",
  ruleCommand: "\u547D\u4EE4",
  ruleArgsPattern: "\u53C2\u6570",
  ruleEnvVar: "\u53D8\u91CF\u540D",
  ruleFlags: "\u6807\u5FD7",
  ruleEnabled: "\u542F\u7528",
  ruleFieldLabel: "\u7B2C {index} \u6761\u89C4\u5219\u7684{field}",
  errorCommand: "\u89C4\u5219\u9700\u8981\u547D\u4EE4\u6A21\u5F0F\uFF1B\u5339\u914D\u6240\u6709\u547D\u4EE4\u8BF7\u5199 .*\u3002",
  errorEnvVar: "\u89C4\u5219\u9700\u8981\u975E\u7A7A\u53D8\u91CF\u540D\u3002",
  errorFlags: "\u4E0D\u662F\u5408\u6CD5\u7684\u6B63\u5219\u6807\u5FD7\u3002",
  errorRegex: "\u4E0D\u662F\u5408\u6CD5\u7684\u6B63\u5219\u3002",
  optionOverrideExisting: "\u8986\u76D6\u5DF2\u6709\u503C",
  optionOverrideExistingHint: "harness \u8FDB\u7A0B\u4E2D\u7684\u503C\u4F1A\u66FF\u6362\u8C03\u7528\u65B9\u5728 spawn spec \u4E2D\u4F20\u5165\u7684\u503C\u3002",
  optionTerminal: "\u8986\u76D6\u7EC8\u7AEF\u4F1A\u8BDD",
  optionTerminalHint: "\u540C\u65F6\u5BF9 spawnTerminal\uFF08PTY \u4F1A\u8BDD\uFF09\u751F\u6548\uFF1B\u6301\u4E45 shell \u9700\u8981\u628A\u89C4\u5219\u5199\u5728 shell \u81EA\u8EAB\u3002",
  optionLogMatches: "\u8BB0\u5F55\u547D\u4E2D",
  optionLogMatchesHint: "\u6BCF\u6B21\u547D\u4E2D\uFF08info\uFF09\u4E0E\u672A\u547D\u4E2D\uFF08debug\uFF09\u5404\u5199\u4E00\u884C\uFF0C\u8D70 env-injector logger \u4E0E stderr\u3002"
};

// src/client/styles.ts
var c = {
  card: "evi-card",
  cardOpen: "evi-cardOpen",
  header: "evi-header",
  headText: "evi-headText",
  name: "evi-name",
  description: "evi-description",
  chevron: "evi-chevron",
  chevronOpen: "evi-chevronOpen",
  pending: "evi-pending",
  body: "evi-body",
  notice: "evi-notice",
  field: "evi-field",
  option: "evi-option",
  optionText: "evi-optionText",
  label: "evi-label",
  badges: "evi-badges",
  reset: "evi-reset",
  hint: "evi-hint",
  error: "evi-error",
  rules: "evi-rules",
  rulesHead: "evi-rulesHead",
  rulesLabel: "evi-rulesLabel",
  rulesHint: "evi-rulesHint",
  rule: "evi-rule",
  ruleGrid: "evi-ruleGrid",
  ruleCell: "evi-ruleCell",
  ruleLabel: "evi-ruleLabel",
  ruleFoot: "evi-ruleFoot",
  empty: "evi-empty",
  actions: "evi-actions",
  footer: "evi-footer",
  failed: "evi-failed"
};
var STYLE_TAG_ID = "dsh-env-injector/client/card.css";
var CSS = `
.evi-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.evi-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.evi-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.evi-header{appearance:none;width:100%;height:auto;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.evi-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.evi-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.evi-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.evi-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.evi-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.evi-chevronOpen{transform:rotate(180deg)}
.evi-pending{flex:none}
.evi-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.evi-notice{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.evi-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.evi-field+.evi-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.evi-option{align-items:flex-start;gap:10px;display:flex}
.evi-option .evi-optionText{flex:1;flex-direction:column;gap:2px;min-width:0;display:flex}
.evi-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.evi-badges{align-items:center;gap:8px;flex:none;display:inline-flex}
.evi-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.evi-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.evi-reset:disabled{cursor:default;opacity:.5}
.evi-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.evi-error{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.evi-rules{border:0;margin:0;padding:4px 0 0;flex-direction:column;display:flex}
.evi-rulesHead{align-items:baseline;gap:8px;flex-wrap:wrap;display:flex}
.evi-rulesLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.evi-rule{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;margin:8px 0 0;padding:10px 12px;flex-direction:column;gap:8px;display:flex}
.evi-ruleGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.evi-ruleCell{flex-direction:column;gap:4px;min-width:0;display:flex}
.evi-ruleLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.evi-ruleFoot{align-items:center;gap:8px;display:flex}
.evi-ruleFoot .evi-optionText{flex:1}
.evi-empty{color:var(--dsw-alias-label-tertiary);margin:8px 0 0;font-size:12px;line-height:1.5}
.evi-actions{padding:8px 0 0;display:flex}
.evi-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.evi-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
`;
function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-env-injector";
  tag.dataset.pluginCss = STYLE_TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

// src/client/card.tsx
var import_jsx_runtime = require("react/jsx-runtime");
ensureStyles();
function issueCopy(issue) {
  if (issue === "command") return "errorCommand";
  if (issue === "envVar") return "errorEnvVar";
  if (issue === "flags") return "errorFlags";
  return "errorRegex";
}
function optionLabel(field) {
  if (field === "overrideExisting") return "optionOverrideExisting";
  if (field === "terminal") return "optionTerminal";
  return "optionLogMatches";
}
function optionHint(field) {
  if (field === "overrideExisting") return "optionOverrideExistingHint";
  if (field === "terminal") return "optionTerminalHint";
  return "optionLogMatchesHint";
}
function OptionRow(props) {
  const { field, state, t, disabled } = props;
  const checked = field === "overrideExisting" ? state.overrideExisting : field === "terminal" ? state.terminal : state.logMatches;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.field, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Switch, { checked, label: t(optionLabel(field)), disabled, onChange: props.onToggle }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: c.optionText, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: c.label, children: t(optionLabel(field)) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: c.hint, children: t(optionHint(field)) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: c.badges, children: [
      state.overridden[field] ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "quiet", children: t("overridden") }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: c.reset, disabled, onClick: props.onReset, children: t("reset") })
    ] })
  ] });
}
function RuleField(props) {
  const id = `${(0, import_react.useId)()}-${props.name}`;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.ruleCell, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: c.ruleLabel, htmlFor: id, children: props.label }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      import_dsh_client_ui_primitives.Input,
      {
        id,
        value: props.value,
        disabled: props.disabled,
        spellCheck: false,
        autoComplete: "off",
        "aria-label": props.ariaLabel,
        "aria-invalid": props.error !== void 0,
        onChange: (event) => {
          props.onChange(event.target.value);
        }
      }
    ),
    props.error === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: c.error, role: "alert", children: props.error })
  ] });
}
function RuleRow(props) {
  const { index, rule, issue, t, disabled } = props;
  const name = (field) => t("ruleFieldLabel", { index: index + 1, field });
  const target = issue === void 0 ? void 0 : issueTarget(rule, issue);
  const error = (field) => issue === void 0 || target !== field ? void 0 : t(issueCopy(issue));
  const edit = (patch) => {
    props.onEdit(patch);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.rule, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.ruleGrid, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        RuleField,
        {
          name: "command",
          label: t("ruleCommand"),
          ariaLabel: name(t("ruleCommand")),
          value: rule.command,
          disabled,
          error: error("command"),
          onChange: (value) => {
            edit({ command: value });
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        RuleField,
        {
          name: "argsPattern",
          label: t("ruleArgsPattern"),
          ariaLabel: name(t("ruleArgsPattern")),
          value: rule.argsPattern,
          disabled,
          error: error("argsPattern"),
          onChange: (value) => {
            edit({ argsPattern: value });
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        RuleField,
        {
          name: "envVar",
          label: t("ruleEnvVar"),
          ariaLabel: name(t("ruleEnvVar")),
          value: rule.envVar,
          disabled,
          error: error("envVar"),
          onChange: (value) => {
            edit({ envVar: value });
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        RuleField,
        {
          name: "flags",
          label: t("ruleFlags"),
          ariaLabel: name(t("ruleFlags")),
          value: rule.flags,
          disabled,
          error: error("flags"),
          onChange: (value) => {
            edit({ flags: value });
          }
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.ruleFoot, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        import_dsh_client_ui_primitives.Switch,
        {
          checked: rule.enabled,
          label: name(t("ruleEnabled")),
          disabled,
          onChange: (next) => {
            edit({ enabled: next });
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: c.optionText, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: c.label, children: t("ruleEnabled") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", disabled, onClick: props.onRemove, children: t("removeRule") })
    ] })
  ] });
}
function EnvInjectorCard(props) {
  const { t } = props;
  const state = props.useEnvInjectorCard((snapshot) => snapshot);
  const [open, setOpen] = (0, import_react.useState)(false);
  const saveStarted = (0, import_react.useRef)(false);
  const rulesId = `${(0, import_react.useId)()}-rules`;
  (0, import_react.useEffect)(() => {
    if (state.saving) {
      saveStarted.current = true;
      return;
    }
    if (!saveStarted.current) return;
    saveStarted.current = false;
    if (!state.dirty && !state.failed) setOpen(false);
  }, [state.dirty, state.failed, state.saving]);
  if (!state.available) return null;
  const title = t("cardTitle");
  const disabled = !state.writable;
  const blocked = !state.dirty || state.invalid || state.saving;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: open ? `${c.card} ${c.cardOpen}` : c.card, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        className: c.header,
        "aria-expanded": open,
        "aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
        onClick: () => {
          setOpen(!open);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: c.headText, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: c.name, children: title }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: c.description, children: t("cardDescription") })
          ] }),
          state.dirty ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "neutral", className: c.pending, children: t("unsaved") }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconChevronDownOutline14, { className: open ? `${c.chevron} ${c.chevronOpen}` : c.chevron })
        ]
      }
    ),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.body, children: [
      disabled ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: c.notice, role: "status", children: t("readOnly") }) : null,
      OPTION_FIELDS.map((field) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        OptionRow,
        {
          field,
          state,
          t,
          disabled,
          onToggle: (next) => {
            props.setOption(field, next);
          },
          onReset: () => {
            props.resetField(field);
          }
        },
        field
      )),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.rules, role: "group", "aria-labelledby": rulesId, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.rulesHead, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: c.rulesLabel, id: rulesId, children: t("rulesLabel") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: c.badges, children: [
            state.overridden.rules ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { tone: "quiet", children: t("overridden") }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                className: c.reset,
                disabled,
                onClick: () => {
                  props.resetField("rules");
                },
                children: t("reset")
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: c.hint, children: t("rulesHint") }),
        state.rules.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: c.empty, children: t("rulesEmpty") }) : null,
        state.rules.map((rule, index) => (
          /* Position is the only identity a rule has: the section stores an
           * ordered list with no per-rule id, so the index is the key. */
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            RuleRow,
            {
              index,
              rule,
              issue: state.issues[index],
              t,
              disabled,
              onEdit: (patch) => {
                props.editRule(index, patch);
              },
              onRemove: () => {
                props.removeRule(index);
              }
            },
            index
          )
        )),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: c.actions, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          import_dsh_client_ui_primitives.Button,
          {
            variant: "outline",
            size: "sm",
            disabled,
            onClick: () => {
              props.addRule();
            },
            children: t("addRule")
          }
        ) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: c.hint, children: t("layerHint") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: c.footer, children: [
        state.failed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: c.failed, role: "status", children: t("saveFailed") }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          import_dsh_client_ui_primitives.Button,
          {
            variant: "outline",
            size: "sm",
            disabled: !state.dirty || state.saving,
            onClick: () => {
              props.discard();
            },
            children: t("discard")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          import_dsh_client_ui_primitives.Button,
          {
            variant: "primary",
            size: "sm",
            disabled: blocked,
            onClick: () => {
              props.save();
            },
            children: t(state.saving ? "saving" : "save")
          }
        )
      ] })
    ] }) : null
  ] });
}

// src/client/controller.ts
var EnvInjectorCardController = class {
  scope;
  staged = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  unsubscribe;
  face;
  source;
  snapshot;
  saving = false;
  failed = false;
  disposed = false;
  /**
   * @param scope - the bound settings scope for the `env-injector` namespace.
   */
  constructor(scope) {
    this.scope = scope;
    this.source = {
      getSnapshot: () => this.snapshot,
      subscribe: (listener) => {
        if (this.disposed) return () => {
        };
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      }
    };
    this.unsubscribe = scope.subscribe(() => {
      this.publish();
    });
    this.snapshot = this.project();
    this.face = this.buildFace();
  }
  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot source and its form actions.
   */
  inject() {
    return this.face;
  }
  /** Release the scope subscription; the registration stays inert from here on. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
  }
  /* ────────────────────────────────────────────────────────────────────────
   * Reads
   * ──────────────────────────────────────────────────────────────────────── */
  /** The value in force for one field: what the host resolved for this client. */
  effective(field) {
    const { value } = this.scope.getSnapshot();
    return value?.[field] ?? SCHEMA_FLOOR[field];
  }
  /** What one field falls back to once the user layer stops carrying it. */
  inherited(field) {
    const { base } = this.scope.getSnapshot();
    const section = base;
    return section?.[field] ?? SCHEMA_FLOOR[field];
  }
  /** The value the control for one field renders. */
  shown(field) {
    const staged = this.staged.get(field);
    if (staged === void 0) return this.effective(field);
    return staged.kind === "set" ? staged.value : this.inherited(field);
  }
  /** Whether the raw user layer carries one field. */
  stored(field) {
    const { user } = this.scope.getSnapshot();
    return user !== null && typeof user === "object" && Object.hasOwn(user, field);
  }
  /** Whether a save would change one field. */
  isDirty(field) {
    const staged = this.staged.get(field);
    if (staged === void 0) return false;
    if (staged.kind === "clear") return this.stored(field);
    return !sameFieldValue(field, staged.value, this.effective(field));
  }
  /** The rule list the editor works on: the staged draft, else what is in force. */
  draftRules() {
    return cloneRules(this.shown("rules"));
  }
  /* ────────────────────────────────────────────────────────────────────────
   * Writes
   * ──────────────────────────────────────────────────────────────────────── */
  /** Publish a projection of the scope and the drafts. */
  publish() {
    if (this.disposed) return;
    this.snapshot = this.project();
    for (const listener of [...this.listeners]) listener();
  }
  /** Build the current state from the scope's snapshot plus the staged drafts. */
  project() {
    const snapshot = this.scope.getSnapshot();
    const rules = this.draftRules();
    const issues = rules.map((rule) => ruleIssue(rule));
    const overridden = {};
    for (const field of CARD_FIELDS) {
      const staged = this.staged.get(field);
      overridden[field] = staged === void 0 ? this.stored(field) : staged.kind === "set";
    }
    const ready = snapshot.status === "ready";
    return {
      available: ready,
      writable: ready && snapshot.writable,
      dirty: CARD_FIELDS.some((field) => this.isDirty(field)),
      invalid: this.isDirty("rules") && issues.some((issue) => issue !== void 0),
      saving: this.saving,
      failed: this.failed,
      rules,
      issues,
      overridden,
      overrideExisting: this.shown("overrideExisting"),
      terminal: this.shown("terminal"),
      logMatches: this.shown("logMatches")
    };
  }
  /** The writes a save would perform, or `undefined` when it must not write. */
  plan() {
    if (this.project().invalid) return void 0;
    const ops = [];
    for (const field of CARD_FIELDS) {
      if (!this.isDirty(field)) continue;
      const staged = this.staged.get(field);
      if (staged === void 0) continue;
      if (staged.kind === "clear") ops.push({ op: "unset", path: [field] });
      else ops.push({ op: "set", path: [field], value: staged.value });
    }
    return ops.length === 0 ? void 0 : ops;
  }
  /** Stage another version of the rule list. */
  stageRules(rules) {
    if (this.disposed) return;
    this.staged.set("rules", { kind: "set", value: rules });
    this.failed = false;
    this.publish();
  }
  /** Stage one field's replacement value. */
  stageSet(field, value) {
    if (this.disposed) return;
    this.staged.set(field, { kind: "set", value });
    this.failed = false;
    this.publish();
  }
  /** Build the actions and the snapshot source the component receives. */
  buildFace() {
    return {
      hooks: { envInjectorCard: this.source },
      editRule: (index, patch) => {
        const rules = this.draftRules();
        const current = rules[index];
        if (current === void 0) return;
        rules[index] = { ...current, ...patch };
        this.stageRules(rules);
      },
      addRule: () => {
        const rules = this.draftRules();
        rules.push(newRule());
        this.stageRules(rules);
      },
      removeRule: (index) => {
        const rules = this.draftRules();
        if (rules[index] === void 0) return;
        rules.splice(index, 1);
        this.stageRules(rules);
      },
      setOption: (field, value) => {
        this.stageSet(field, value);
      },
      resetField: (field) => {
        if (this.disposed) return;
        this.staged.set(field, { kind: "clear" });
        this.failed = false;
        this.publish();
      },
      discard: () => {
        if (this.disposed) return;
        this.staged.clear();
        this.failed = false;
        this.publish();
      },
      save: () => {
        if (this.disposed || this.saving) return;
        const ops = this.plan();
        if (ops === void 0) return;
        const written = ops.map((op) => op.path[0]);
        this.saving = true;
        this.failed = false;
        this.publish();
        void this.scope.mutate(ops).then(
          () => {
            if (this.disposed) return;
            for (const field of written) this.staged.delete(field);
            this.saving = false;
            this.publish();
          },
          () => {
            if (this.disposed) return;
            this.saving = false;
            this.failed = true;
            this.publish();
          }
        );
      }
    };
  }
};

// src/client/index.tsx
var inject = ["slots", "locale", "settingsScope"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), "env-injector: card dictionaries");
  const controller = new EnvInjectorCardController(ctx.settingsScope.bind({ namespace: NS }));
  ctx.effect(() => () => {
    controller.dispose();
  }, "env-injector: card state");
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    key: NS,
    locale: NS,
    inject: () => controller.inject()
  }, EnvInjectorCard));
}
		return module.exports;
	}
});

