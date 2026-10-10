import { DEFAULT_FONT_FAMILY } from '../font-settings.js';

// Shadow-root styles use the same neutral surfaces and indigo accent as the panel.
export const enhancementStyles = `
:host {
  all:initial; display:block; position:relative; flex:0 0 auto; align-self:stretch; box-sizing:border-box;
  font-family:var(--sider-font-family,${DEFAULT_FONT_FAMILY});
  font-size:12px; line-height:1.5; width:100%; min-width:0; z-index:30; color:var(--ink); color-scheme:light;
  --canvas:#f3f4f8; --surface:#fff; --subtle:#f6f7fb; --inset:#eef0f6; --hover:#e9edf5;
  --line:#dfe3ed; --control-line:#bac3d5; --ink:#20283d; --muted:#5d6880;
  --focus:#4f46c8; --accent-hover:#4138b1; --highlight:#efedff; --accent-line:#c6c1f0; --on-accent:#fff;
  --danger:#b42335; --danger-soft:#fff0f1;
}
:host([data-dark]) {
  --canvas:#141721; --surface:#1e2331; --subtle:#252b3b; --inset:#181d29; --hover:#30394e;
  --line:#394257; --control-line:#626f8b; --ink:#edf0fa; --muted:#b1bbd0;
  --focus:#b6b0ff; --accent-hover:#ccc8ff; --highlight:#302d50; --accent-line:#7971b9; --on-accent:#211a50;
  --danger:#ff9caa; --danger-soft:#422932; color-scheme:dark;
}
*{box-sizing:border-box} [hidden]{display:none!important}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid transparent;background:transparent;padding:6px 8px;border-radius:7px;line-height:1.4;white-space:nowrap}
button:hover{background:var(--hover)} button:active:not(:disabled){background:var(--inset)}
button:disabled{opacity:.45;cursor:default} button:disabled:hover{background:transparent} button[data-busy]{cursor:wait}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,.chip .excerpt:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.bar{display:flex;gap:5px;align-items:center;min-height:32px;padding:5px 2px 2px;border-top:1px solid var(--line);margin-top:5px;min-width:0}
.bar>button{font-size:11px;padding:5px 8px;flex:none;background:var(--highlight);color:var(--focus);border-color:var(--accent-line);font-weight:600}
.bar>button:hover{background:var(--hover)} .bar>button:last-child{margin-left:auto}
.chips{display:flex;gap:5px;align-items:center;flex-wrap:wrap;min-width:0;flex:1}
.chip{display:flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:7px;background:var(--subtle);font-size:11px;padding-left:7px;max-width:100%;min-width:0}
.chip button{font-size:15px;line-height:1;padding:4px 6px;flex:none;color:var(--muted)}
.chip .excerpt{cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.selection-chip{flex:0 1 auto;max-width:100%;color:var(--ink)} .selection-icon{color:var(--focus);flex:none}
.popover{position:fixed;inset:auto;margin:0;z-index:2147483646;width:380px;max-width:calc(100vw - 20px);max-height:min(640px,80dvh);background:var(--canvas);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 16px 48px #121b3430;overflow:auto;color:var(--ink);overscroll-behavior:contain;scroll-padding-block:62px 72px;scrollbar-width:thin;scrollbar-color:var(--control-line) transparent}
.heading{position:sticky;top:-14px;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--canvas);padding:12px 14px;margin:-14px -14px 14px;border-bottom:1px solid var(--line)}
.heading strong{font-size:14px;font-weight:650} .heading button{font-size:21px;padding:0;min-width:28px;min-height:28px;color:var(--muted)}
.note{font-size:11px;line-height:1.75;color:var(--muted);margin:8px 0;white-space:pre-line;overflow-wrap:anywhere}
.status{font-size:11px;line-height:1.7;margin:2px 2px 6px;color:var(--muted);overflow-wrap:anywhere} .status.error{color:var(--danger)}
.access{font-size:11px;color:var(--focus);border:1px solid var(--accent-line);background:var(--highlight);margin-bottom:6px}
.form label{display:block;font-size:11px;font-weight:550;margin:12px 0 6px}
.form input,.form textarea,.form select{display:block;width:100%;min-width:0;border:1px solid var(--control-line);border-radius:8px;padding:8px 10px;background:var(--surface);font-size:12px;line-height:1.8;resize:vertical}
.form input::placeholder,.form textarea::placeholder{color:var(--muted)} .form textarea{max-height:200px}
.form input:hover:not(:disabled),.form textarea:hover,.form select:hover:not(:disabled){border-color:var(--focus)}
.form [aria-invalid="true"]{border-color:var(--danger)} .form .field-error{color:var(--danger);margin:8px 0} .field-error:empty{display:none}
.form-section{margin:12px 0;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
.form-section:first-child{margin-top:0} .form-section h3{font-size:12px;font-weight:650;margin:-12px -12px 12px;padding:11px 12px;border-bottom:1px solid var(--line);background:var(--subtle);border-radius:10px 10px 0 0}
.form-section>label:first-of-type{margin-top:0} .form-section>.note:last-child{margin-bottom:0}
.form .template-toggle{display:flex;align-items:flex-start;gap:8px;margin:12px 0;line-height:1.7;font-weight:400}
.form .template-toggle input{width:15px;height:15px;flex:none;padding:0;margin:2px 0 0;accent-color:var(--focus)}
.inline-action{color:var(--focus);font-size:11px;padding:7px 0;margin-top:2px}
.variables{font-size:11px;margin:12px 0;border:1px solid var(--line);border-radius:9px;background:var(--surface)}
.variables summary{display:flex;align-items:center;gap:9px;cursor:pointer;list-style:none;padding:12px;font-weight:600;background:var(--subtle);border-radius:9px}
.variables summary::-webkit-details-marker{display:none}
.variables summary::before{content:"";width:6px;height:6px;flex:none;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);color:var(--muted);transition:transform 120ms ease}
.variables[open]>summary{border-bottom:1px solid var(--line);border-radius:9px 9px 0 0} .variables[open]>summary::before{transform:rotate(45deg)}
.variables summary:hover{color:var(--focus);background:var(--hover)} .variables summary:focus-visible{outline-offset:-3px}
.variables-body{padding:0 12px 12px} .variable{border-top:1px solid var(--line);padding:9px 12px;overflow-wrap:anywhere}
.variable:first-of-type{border-top:0} .variable p{margin:4px 0;color:var(--muted);line-height:1.75} .variable button{color:var(--focus);padding:3px 0}
.footer{position:sticky;bottom:-14px;z-index:1;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;margin:14px -14px -14px;padding:12px 14px;border-top:1px solid var(--line);background:var(--surface)}
.footer button{border:1px solid var(--control-line);font-size:11px;padding:8px 10px}
.footer .primary{background:var(--focus);color:var(--on-accent);border-color:transparent;font-weight:600} .footer .primary:hover{background:var(--accent-hover)}
.preset-list-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:16px 0 8px} .preset-list-heading strong{font-size:12px;font-weight:600} .preset-list-heading span{font-size:10px;color:var(--muted)}
.preset-list{padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
.template-row{display:flex;gap:4px;align-items:center;flex-wrap:nowrap;padding:5px 3px;margin:2px 0;border:1px solid transparent;border-radius:7px}
.template-row+.template-row{border-top-color:var(--line)} .template-row:has(input:checked){background:var(--highlight);border-color:var(--accent-line)}
.template-row>button{min-height:30px;font-size:11px;padding:4px;flex-shrink:0}
.template-row .template-use{flex:1;min-width:0;white-space:normal;text-align:left;overflow-wrap:anywhere;line-height:1.6;padding:5px 3px}
.template-name{display:block;font-size:12px;font-weight:550} .template-action{display:block;font-size:10px;font-weight:400;color:var(--muted);margin-top:2px}
.template-row:has(input:checked) .template-name{color:var(--focus)}
.template-row [data-sort-handle]{flex:0 0 auto;color:var(--muted);cursor:grab;touch-action:none;user-select:none;font-size:16px}
.sorting [data-sort-handle]{cursor:grabbing} .template-row.dragging{opacity:.6;background:var(--hover)}
.drop-before{box-shadow:0 -2px var(--focus)} .drop-after{box-shadow:0 2px var(--focus)}
.form .template-row>input{width:15px;height:15px;flex:none;padding:0;margin:0 3px;accent-color:var(--focus);cursor:pointer}
.preset-add{width:100%;margin-top:8px;padding:9px;color:var(--focus);background:var(--surface);border:1px dashed var(--control-line);font-size:11px}
.danger{color:var(--danger)} .danger:hover{background:var(--danger-soft)}
.page-body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:36dvh;overflow:auto;font-size:12px;line-height:1.8;font-family:inherit;user-select:text;background:var(--surface);padding:12px;border:1px solid var(--line);border-radius:8px}
.page-meta{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;color:var(--muted)}
.source{font-size:11px;color:var(--muted);line-height:1.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0 0 9px;padding:8px 10px;background:var(--surface);border-radius:7px}
.source-picker{margin-bottom:9px;min-width:0} .source-label{margin:0 0 7px;font-size:11px;font-weight:600;color:var(--muted)}
.source-line{display:flex;align-items:center;gap:5px;min-width:0}
.source-trigger{display:flex;gap:8px;align-items:center;justify-content:space-between;flex:1;min-width:0;text-align:left;margin:0;border:1px solid var(--control-line);color:var(--ink)}
.source-trigger:hover,.source-trigger[aria-expanded="true"]{border-color:var(--focus);background:var(--surface)}
.source-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.source-back{flex:none;font-size:11px;color:var(--focus);padding:7px 5px}
.source-menu{margin-top:6px;border:1px solid var(--control-line);border-radius:9px;padding:7px;background:var(--surface)}
.source-options{max-height:min(260px,34dvh);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;margin-top:5px}
.source-window{font-size:10px;color:var(--muted);padding:7px 6px 3px}
.source-option{display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;padding:7px 8px;border:1px solid transparent;white-space:normal;min-width:0}
.source-option-title,.source-option-url{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.source-option-title{font-size:11px} .source-option-url{font-size:10px;color:var(--muted)}
.source-option[aria-selected="true"]{color:var(--focus)} .source-option.active{background:var(--highlight);border-color:var(--focus)}
.source-menu .note{margin:5px 3px} .form .source-search{font-size:11px;padding:6px 8px}
button,summary{transition:background-color 120ms cubic-bezier(.2,.8,.2,1),color 120ms cubic-bezier(.2,.8,.2,1),opacity 120ms cubic-bezier(.2,.8,.2,1)}
.template-row{transition:background-color 120ms ease,opacity 120ms ease} .preset-list button{transition-property:background-color,color}
[data-motion-closing]{pointer-events:none}
@media(max-width:360px){.popover{padding:12px}.heading{top:-12px;margin:-12px -12px 12px;padding-inline:12px}.footer{bottom:-12px;margin-inline:-12px;margin-bottom:-12px;padding-inline:12px}.form-section{padding:10px}.form-section h3{margin:-10px -10px 10px;padding:10px}.template-row{gap:2px}.template-row>button{padding-inline:3px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important}}
`;
