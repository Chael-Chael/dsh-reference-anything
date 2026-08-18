import type { ChatProvider } from '../wire.ts'
import type { SyncStatus } from './remote.ts'
import { PROVIDER_ICON_MARKER, PROVIDER_ICON_PATH, SESSION_ICON_MARKER } from './provider-icons.tsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { REFERENCE_ANYTHING_NS } from './locale.ts'

const css = `
/* The unified @ trigger menu is owned by DSH, but the plugin can style its
   public ARIA/data contract without depending on generated CSS-module names. */
[data-composer-card] [role="listbox"]:has([role="presentation"][data-source]){box-sizing:border-box!important;width:100%!important;min-width:0!important;max-width:100%!important;border-radius:22px!important}
[data-composer-card] [role="listbox"] [role="presentation"][data-source]:not(:first-child){margin-top:4px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-inverted)}
[data-composer-card] [role="listbox"] [role="presentation"][data-source="External conversations"]{display:flex;align-items:center;justify-content:flex-start;gap:8px}
.dsh_ref_menu_sync{position:relative;display:inline-grid;place-items:center;flex:none;min-width:96px;height:26px;padding:0 11px;overflow:hidden;border:1px solid rgba(59,130,246,.28);border-radius:999px;background:rgba(59,130,246,.11);color:var(--dsw-alias-state-business-primary,#3b82f6);font:650 11px/1 Geist,"Segoe UI",sans-serif;cursor:pointer;isolation:isolate;transition:background .16s ease,border-color .16s ease,transform .16s ease}.dsh_ref_menu_sync:hover:not(:disabled){border-color:rgba(59,130,246,.42);background:rgba(59,130,246,.16)}.dsh_ref_menu_sync:active:not(:disabled){transform:translateY(1px)}.dsh_ref_menu_sync:disabled{cursor:default;opacity:.86}.dsh_ref_menu_sync>span{position:relative;z-index:1;white-space:nowrap}.dsh_ref_menu_sync>i{position:absolute;inset:0;z-index:0;background:rgba(59,130,246,.14);transform:scaleX(var(--dsh-ref-sync-progress,0));transform-origin:left;transition:transform .2s ease}.dsh_ref_menu_sync.is_listing>i{width:35%;animation:dsh-ref-menu-listing 1.1s ease-in-out infinite;transform:translateX(-110%)}@keyframes dsh-ref-menu-listing{50%{transform:translateX(285%)}100%{transform:translateX(-110%)}}
.dsh_ref_menu_expand{display:block;width:auto;min-height:30px;padding:4px 12px;border:0!important;border-radius:0!important;background:none!important;box-shadow:none!important;color:var(--dsw-alias-label-tertiary,#8b8f98);font:600 14px/22px Geist,"Segoe UI",sans-serif;cursor:pointer;text-align:left}.dsh_ref_menu_expand:hover{background:none!important;color:var(--dsw-alias-label-tertiary,#8b8f98);text-decoration:underline}
.dsh_ref_menu_collapsed{display:none!important}
/* Codex-like inline references: no filled rounded rectangle. The label uses
   the same semantic blue as DSH's send button/caret and is allowed to show
   its complete title instead of the core chip's ellipsis projection. */
[data-composer-card] [data-decoration="chip"]{display:inline-flex!important;align-items:center!important;width:max-content!important;min-width:4em;border-radius:0!important;background:transparent!important;overflow:visible!important;vertical-align:baseline}
[data-composer-card] [data-decoration="chip"]:before{display:none!important}
[data-composer-card] [data-decoration="chip"]>span{position:static!important;width:max-content!important;max-width:none!important;justify-content:flex-start!important;overflow:visible!important;color:var(--dsw-alias-state-business-primary)!important;font-family:inherit!important;font-size:inherit!important;line-height:inherit!important;font-weight:600;transform:none!important;z-index:2}
.dsh_ref_projected_icon{display:inline-flex!important;align-items:center;gap:.35em}.dsh_ref_projected_icon:before{content:"";display:inline-block;flex:none;width:1em;height:1em;background:currentColor;mask:var(--dsh-ref-provider-icon) center/contain no-repeat;-webkit-mask:var(--dsh-ref-provider-icon) center/contain no-repeat}[data-composer-card] .dsh_ref_conversation_chip,[data-composer-card] .dsh_ref_conversation_chip>span,[data-composer-card] .dsh_ref_projected_icon{color:var(--dsw-alias-state-business-primary,#3b82f6)!important}[data-composer-card] [role="listbox"] .dsh_ref_projected_icon:before{background:var(--dsw-alias-label-tertiary,#8b8f98)}[data-composer-card] .dsh_ref_conversation_chip>.dsh_ref_projected_icon{transform:translateY(.2em)!important}
.dsh_ref_session_icon{display:inline-flex!important;align-items:center;gap:.45em}.dsh_ref_session_icon:before{content:"";display:inline-block;flex:none;width:1.05em;height:1.05em;background:var(--dsw-alias-label-secondary,#5f636b);mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='none' stroke='black' stroke-width='1.65' stroke-linecap='round' stroke-linejoin='round' d='M21 11.5a8.4 8.4 0 0 1-9 8.4 9.3 9.3 0 0 1-4-1L3.5 20l1.45-3.85A8.4 8.4 0 1 1 21 11.5Z'/%3E%3C/svg%3E") center/contain no-repeat;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='none' stroke='black' stroke-width='1.65' stroke-linecap='round' stroke-linejoin='round' d='M21 11.5a8.4 8.4 0 0 1-9 8.4 9.3 9.3 0 0 1-4-1L3.5 20l1.45-3.85A8.4 8.4 0 1 1 21 11.5Z'/%3E%3C/svg%3E") center/contain no-repeat}
[data-composer-card] [data-decoration="text-ref"]{border-radius:0!important;background:transparent!important;color:var(--dsw-alias-state-business-primary)!important;font-family:inherit!important;font-size:inherit!important;line-height:inherit!important;font-weight:600;box-shadow:none!important}
[data-composer-card] [data-decoration="text-ref"]:before,[data-composer-card] [data-decoration="text-ref"]:after{display:none!important}
.dsh_ref_native_caret_hidden{caret-color:transparent!important}.dsh_ref_adaptive_caret{position:fixed;z-index:9999;box-sizing:border-box;width:1px;margin:0;padding:0;border:0;border-radius:0;pointer-events:none;background:var(--dsw-alias-state-business-primary);opacity:1;animation:dsh_ref_caret_blink 1.06s step-end infinite;transform:translateZ(0)}.dsh_ref_adaptive_caret[hidden]{display:none!important}@keyframes dsh_ref_caret_blink{0%,49.99%{opacity:1}50%,100%{opacity:0}}
.dsh_ref_message_reference{display:inline-flex;align-items:center;gap:6px;max-width:100%;color:#82b1e4;font-weight:600;white-space:nowrap;vertical-align:baseline}.dsh_ref_message_reference:before{content:"";display:inline-block;flex:none;width:20px;height:20px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' d='M20 11.5a8 8 0 0 1-8.5 8A8.9 8.9 0 0 1 7.7 18.6L3.5 20l1.4-3.7A8 8 0 1 1 20 11.5Z'/%3E%3C/svg%3E") center/contain no-repeat}
.dsh_ref_settings{display:flex;flex-direction:column;gap:18px;width:min(100%,1060px);padding:0 0 36px;color:var(--dsw-alias-label-primary);font-family:Geist,"Segoe UI",sans-serif}.dsh_ref_settings *{box-sizing:border-box}.dsh_ref_header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:0 0 10px}.dsh_ref_header h2{margin:0 0 7px;font-size:28px;line-height:1.1;letter-spacing:-.035em}.dsh_ref_header p{margin:0;max-width:620px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.dsh_ref_settings button{min-height:34px;padding:0 13px;border:1px solid var(--dsw-alias-label-primary);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:650;cursor:pointer}.dsh_ref_settings button:hover:not(:disabled){background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}.dsh_ref_settings button:active:not(:disabled){transform:translateY(1px)}.dsh_ref_settings button:disabled{cursor:not-allowed;opacity:.42}
.dsh_ref_workspace{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent;overflow:hidden}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{margin:0;padding:24px;border:0;border-bottom:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent}.dsh_ref_workspace>.dsh_ref_panel:last-child{border-bottom:0}.dsh_ref_workspace>.dsh_ref_error{margin:20px 24px 0}.dsh_ref_section_head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.dsh_ref_section_head h3{margin:0 0 4px;font-size:17px;letter-spacing:-.02em}.dsh_ref_section_head p{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.45}.dsh_ref_health,.dsh_ref_syncing{display:inline-flex;align-items:center;min-height:25px;padding:0 9px;border:1px solid var(--dsw-alias-label-primary);border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary);font-size:10px;font-weight:700}
.dsh_ref_checklist{display:grid;gap:14px;margin-top:20px}.dsh_ref_check{display:flex;align-items:flex-start;gap:11px;min-height:40px}.dsh_ref_check>span{display:grid;place-items:center;flex:none;width:22px;height:22px;margin-top:2px;border:1px solid var(--dsw-alias-label-primary);border-radius:50%;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;font-weight:800}.dsh_ref_check div{display:grid;min-width:0;gap:2px}.dsh_ref_check strong{font-size:13px}.dsh_ref_check small{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-size:11px;opacity:.7}.dsh_ref_install{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:20px;padding:14px;border:1px solid var(--dsw-alias-label-primary);background:transparent}.dsh_ref_install>div{display:grid;gap:3px}.dsh_ref_install strong{font-size:12px}.dsh_ref_install span{color:var(--dsw-alias-label-primary);font-size:11px;opacity:.7}.dsh_ref_service_actions{display:flex!important;flex:none;gap:8px}.dsh_ref_error{display:grid;gap:4px;padding:13px;border:1px solid var(--dsw-alias-label-primary);background:transparent;color:var(--dsw-alias-label-primary);font-size:11px}.dsh_ref_skeleton{display:grid;gap:12px;margin-top:20px}.dsh_ref_skeleton i{height:40px;border:1px solid var(--dsw-alias-label-primary);opacity:.25}
.dsh_ref_sources{display:grid;gap:17px}.dsh_ref_provider_grid{display:grid;grid-template-columns:1fr;gap:0;border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_provider{display:grid;grid-template-columns:34px minmax(96px,1fr) minmax(110px,.8fr) minmax(150px,1.3fr) auto;align-items:center;min-width:0;padding:12px 14px;border:0;border-bottom:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent}.dsh_ref_provider:last-child{border-bottom:0}.dsh_ref_provider_top{display:contents}.dsh_ref_provider_mark{display:grid;grid-column:1;place-items:center;width:30px;height:30px;border:1px solid var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}.dsh_ref_provider_top>span:not(.dsh_ref_provider_mark):not(.dsh_ref_status_dot){display:none}.dsh_ref_status_dot{display:none}.dsh_ref_provider h4{grid-column:2;margin:0;font-size:13px}.dsh_ref_provider>strong{display:inline-flex;grid-column:3;align-items:baseline;justify-self:start;gap:3px;font-family:"Geist Mono",Consolas,monospace;font-size:18px;white-space:nowrap}.dsh_ref_provider>strong span{font-family:Geist,"Segoe UI",sans-serif;font-size:11px;font-weight:600}.dsh_ref_provider>small{grid-column:4;margin:0;color:var(--dsw-alias-label-primary);font-size:10px;opacity:.7}.dsh_ref_provider>em{display:none}.dsh_ref_provider_foot{display:contents}.dsh_ref_provider_foot>span{display:none}.dsh_ref_provider_actions{grid-column:5;display:flex;gap:6px}.dsh_ref_provider_foot button{min-height:29px;padding:0 10px;font-size:10px}.dsh_ref_empty{padding:20px;border:1px dashed var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:11px;text-align:center}
.dsh_ref_general_settings{display:grid;gap:16px}.dsh_ref_picker_list{border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_picker_row{display:grid;grid-template-columns:minmax(170px,1fr) auto auto;align-items:center;gap:14px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-label-primary)}.dsh_ref_picker_row:last-child{border-bottom:0}.dsh_ref_picker_row>label:first-child{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:650}.dsh_ref_picker_row input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-label-primary)}.dsh_ref_picker_limit{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-primary);font-size:10px}.dsh_ref_picker_limit input{height:30px;width:58px;padding:0 6px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent;color:var(--dsw-alias-label-primary);font:11px Geist,"Segoe UI",sans-serif}.dsh_ref_picker_order{display:flex;gap:5px}.dsh_ref_picker_order button{min-width:30px;min-height:30px;padding:0;font-size:15px;line-height:1}
.dsh_ref_sync_settings{display:grid;gap:20px}.dsh_ref_form_grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.dsh_ref_form_grid label{display:grid;gap:6px}.dsh_ref_form_grid label>span{font-size:11px;font-weight:650}.dsh_ref_form_grid input,.dsh_ref_form_grid select{width:100%;height:36px;padding:0 10px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px Geist,"Segoe UI",sans-serif}.dsh_ref_form_grid input:focus,.dsh_ref_form_grid select:focus{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.dsh_ref_form_grid input[aria-invalid=true]{border-style:dashed}.dsh_ref_form_grid select:disabled{opacity:.42}.dsh_ref_toggle{display:flex!important;flex-direction:row!important;align-items:center;gap:8px;cursor:pointer}.dsh_ref_toggle input{position:absolute;opacity:0}.dsh_ref_toggle>span{position:relative;width:32px;height:18px;border:1px solid var(--dsw-alias-label-primary);border-radius:9px;background:transparent}.dsh_ref_toggle>span:after{content:"";position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .18s}.dsh_ref_toggle input:checked+span:after{transform:translateX(14px)}.dsh_ref_toggle b{font-size:11px}.dsh_ref_actions{display:flex;flex-wrap:wrap;gap:8px}.dsh_ref_actions .is_primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}.dsh_ref_actions .is_danger{border-style:dashed}.dsh_ref_inline_error,.dsh_ref_auto_note{margin:0;color:var(--dsw-alias-label-primary);font-size:11px}.dsh_ref_auto_note{opacity:.7}.dsh_ref_notice{padding:10px 0;border-bottom:1px solid var(--dsw-alias-label-primary);font-size:11px}
.dsh_ref_progress_wrap{display:grid;gap:6px;margin-top:4px}.dsh_ref_progress_track{height:6px;border:1px solid var(--dsw-alias-label-primary);background:transparent;overflow:hidden}.dsh_ref_progress_fill{height:100%;background:var(--dsw-alias-label-primary);transition:width .2s ease}.dsh_ref_progress_track.is_listing .dsh_ref_progress_fill{min-width:8%;animation:dsh-ref-listing 1.2s ease-in-out infinite}.dsh_ref_progress_fill.is_failed,.dsh_ref_progress_fill.is_cancelled{opacity:.4}.dsh_ref_progress_fill.is_partial{opacity:.7}.dsh_ref_progress_label{margin:0;color:var(--dsw-alias-label-primary);font-size:10px;text-transform:lowercase;opacity:.7}.dsh_ref_progress_sources{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px 12px}.dsh_ref_progress_sources span{display:flex;justify-content:space-between;gap:8px;font-size:10px}.dsh_ref_progress_sources i{font-style:normal;opacity:.65}@keyframes dsh-ref-listing{0%,100%{transform:translateX(-20%);opacity:.45}50%{transform:translateX(20%);opacity:1}}
.dsh_ref_manage{display:grid;gap:15px}.dsh_ref_manage_filters{display:grid;grid-template-columns:1fr 180px;gap:12px}.dsh_ref_manage_filters input,.dsh_ref_manage_filters select{width:100%;height:36px;padding:0 10px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px Geist,"Segoe UI",sans-serif}.dsh_ref_manage_filters input:focus,.dsh_ref_manage_filters select:focus{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.dsh_ref_manage_empty{margin:0;padding:20px;border:1px dashed var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:11px;text-align:center}
.dsh_ref_manage_list{list-style:none;display:grid;gap:0;margin:0;padding:0;max-height:340px;overflow-y:auto;border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_manage_row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 13px;border-bottom:1px solid var(--dsw-alias-label-primary)}.dsh_ref_manage_row:last-child{border-bottom:0}.dsh_ref_manage_main{display:grid;gap:3px;min-width:0}.dsh_ref_manage_title_row{display:flex;align-items:center;flex-wrap:wrap;gap:7px;min-width:0}.dsh_ref_manage_title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px;font-size:13px}.dsh_ref_manage_meta{color:var(--dsw-alias-label-primary);font-size:10px;opacity:.7}.dsh_ref_manage_row button{min-height:29px;padding:0 10px;font-size:10px;flex:none}.dsh_ref_manage_row .is_danger{border-style:dashed}
.dsh_ref_badge{padding:1px 7px;border:1px solid var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:10px;white-space:nowrap}.dsh_ref_badge.is_warn{border-style:dashed}
.dsh_ref_pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-primary);font-size:10px}.dsh_ref_pagination button{min-height:29px;padding:0 10px;font-size:10px}
@media(max-width:640px){.dsh_ref_manage_filters{grid-template-columns:1fr}.dsh_ref_manage_row{align-items:flex-start;flex-direction:column}.dsh_ref_manage_title{max-width:100%}}
@media(max-width:850px){.dsh_ref_provider_grid{grid-template-columns:1fr 1fr}}@media(max-width:640px){.dsh_ref_header,.dsh_ref_section_head,.dsh_ref_install{align-items:stretch;flex-direction:column}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{padding:18px}.dsh_ref_provider_grid,.dsh_ref_form_grid,.dsh_ref_picker_row{grid-template-columns:1fr}.dsh_ref_picker_limit{justify-content:space-between}.dsh_ref_recheck,.dsh_ref_install button{align-self:flex-start}}
/* DSH-style settings surface: quiet neutral groups, one blue accent, and
   rounded controls. These overrides deliberately use plugin-local classes so
   they cannot restyle DSH settings owned by other plugins. */
.dsh_ref_settings{--dsh-ref-blue:var(--dsw-alias-state-business-primary,#3b82f6);--dsh-ref-blue-soft:rgba(59,130,246,.11);--dsh-ref-blue-line:rgba(59,130,246,.28);--dsh-ref-line:rgba(100,116,139,.20);--dsh-ref-surface:rgba(148,163,184,.055);--dsh-ref-card-surface:rgba(255,255,255,.26);--dsh-ref-control-surface:rgba(255,255,255,.38);gap:20px;color:var(--dsw-alias-label-primary)}
/* The settings shell owns a nested scrollport. overflow:hidden still allows
   focus-driven programmatic scrolling on the outer dialog, which shifts the
   whole panel upward after a saved toggle and leaves a large blank region. */
[role="dialog"]:has(.dsh_ref_settings){overflow:clip!important}
.dsh_ref_toggle{position:relative}
body[data-ds-dark-theme] .dsh_ref_settings{--dsh-ref-card-surface:var(--dsw-alias-bg-layer-1,#303038);--dsh-ref-control-surface:var(--dsw-alias-bg-layer-2,#363640)}
.dsh_ref_header{padding:2px 2px 4px}.dsh_ref_header h2{font-size:26px;font-weight:700;letter-spacing:-.025em}.dsh_ref_header p{max-width:660px;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));line-height:1.55}.dsh_ref_settings button{border-color:var(--dsh-ref-line);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font-weight:600;transition:background .16s ease,border-color .16s ease,color .16s ease,transform .16s ease}.dsh_ref_settings button:hover:not(:disabled){border-color:var(--dsh-ref-blue-line);background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue)}
.dsh_ref_recheck{border-color:var(--dsh-ref-blue-line)!important;color:var(--dsh-ref-blue)!important;background:var(--dsh-ref-blue-soft)!important}.dsh_ref_recheck:hover:not(:disabled){background:var(--dsh-ref-blue)!important;color:#fff!important}
.dsh_ref_workspace{gap:12px;border:0;border-radius:0;background:transparent;overflow:visible}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{padding:20px;border:1px solid var(--dsh-ref-line);border-radius:14px;background:var(--dsh-ref-surface)}.dsh_ref_workspace>.dsh_ref_panel:last-child{border-bottom:1px solid var(--dsh-ref-line)}.dsh_ref_workspace>.dsh_ref_error{margin:0;border-color:rgba(239,68,68,.3);border-radius:12px;background:rgba(239,68,68,.06)}.dsh_ref_notice{padding:10px 12px;border:1px solid var(--dsh-ref-blue-line);border-radius:10px;background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue)}
.dsh_ref_section_head h3{font-size:16px;font-weight:700;letter-spacing:-.015em}.dsh_ref_section_head p{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));line-height:1.5}.dsh_ref_health,.dsh_ref_syncing{border-color:var(--dsh-ref-blue-line);border-radius:999px;background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue);font-weight:650}.dsh_ref_checklist{gap:13px}.dsh_ref_check>span{border-color:var(--dsh-ref-blue-line);background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue)}.dsh_ref_check small{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));line-height:1.45}
.dsh_ref_install{margin-top:18px;padding:13px 14px;border-color:var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_install span{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary))}.dsh_ref_service_actions button:first-child{border-color:var(--dsh-ref-blue-line);color:var(--dsh-ref-blue)}.dsh_ref_service_actions button.is_primary{border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue);color:#fff}.dsh_ref_service_actions button.is_primary:hover:not(:disabled){filter:brightness(.94)}
.dsh_ref_general_settings{gap:15px}.dsh_ref_picker_list{overflow:hidden;border-color:var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_picker_row{grid-template-columns:minmax(150px,1fr) auto auto;gap:12px;padding:10px 12px;border-color:var(--dsh-ref-line)}.dsh_ref_picker_row>label:first-child{color:var(--dsw-alias-label-primary)}.dsh_ref_picker_row input{accent-color:var(--dsh-ref-blue)}.dsh_ref_picker_limit{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary))}.dsh_ref_picker_limit select{border-color:var(--dsh-ref-line);border-radius:7px;background:transparent}.dsh_ref_picker_limit select:focus{outline:2px solid var(--dsh-ref-blue-line);outline-offset:1px}.dsh_ref_picker_order button{min-width:29px;border-color:transparent;background:transparent;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary))}.dsh_ref_picker_order button:hover:not(:disabled){border-color:transparent;background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue)}
.dsh_ref_provider_grid{overflow:hidden;border-color:var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_provider{border-color:var(--dsh-ref-line);transition:background .16s ease}.dsh_ref_provider:hover{background:var(--dsh-ref-blue-soft)}.dsh_ref_provider_mark{border-color:var(--dsh-ref-blue-line);border-radius:8px;color:var(--dsh-ref-blue)}.dsh_ref_provider>small{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));opacity:1}.dsh_ref_provider_foot button{border-color:var(--dsh-ref-blue-line);border-radius:7px;color:var(--dsh-ref-blue)}
.dsh_ref_sync_settings{gap:18px}.dsh_ref_form_grid input,.dsh_ref_form_grid select,.dsh_ref_manage_filters input,.dsh_ref_manage_filters select{border-color:var(--dsh-ref-line);border-radius:8px;background:var(--dsh-ref-control-surface)}.dsh_ref_form_grid input:focus,.dsh_ref_form_grid select:focus,.dsh_ref_manage_filters input:focus,.dsh_ref_manage_filters select:focus{outline-color:var(--dsh-ref-blue-line)}.dsh_ref_field_note{margin:0;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));font-size:11px;font-weight:400;line-height:1.45}.dsh_ref_toggle>span{border-color:var(--dsh-ref-blue-line);background:var(--dsh-ref-blue-soft)}.dsh_ref_toggle>span:after{background:var(--dsh-ref-blue)}.dsh_ref_actions .is_primary{border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue);color:#fff}.dsh_ref_actions .is_primary:hover:not(:disabled){background:var(--dsh-ref-blue);color:#fff;filter:brightness(.94)}.dsh_ref_progress_track{border:0;border-radius:999px;background:var(--dsh-ref-blue-soft)}.dsh_ref_progress_fill{border-radius:999px;background:var(--dsh-ref-blue)}
.dsh_ref_viability_actions{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:8px}.dsh_ref_picker_limit input{border-color:var(--dsh-ref-line);border-radius:7px;background:transparent}.dsh_ref_picker_limit input:focus{outline:2px solid var(--dsh-ref-blue-line);outline-offset:1px}.dsh_ref_picker_order button{color:var(--dsw-alias-label-primary)}body[data-ds-dark-theme] .dsh_ref_picker_order button{color:var(--dsw-alias-label-tertiary,#cbd5e1)}.dsh_ref_provider{grid-template-columns:34px minmax(130px,1fr) minmax(185px,1.1fr) max-content;grid-template-rows:auto auto;row-gap:2px;padding-inline:14px}.dsh_ref_provider_mark{grid-row:1 / span 2}.dsh_ref_provider h4{grid-row:1 / span 2;align-self:center}.dsh_ref_provider>strong{grid-row:1}.dsh_ref_provider>small{grid-column:3;grid-row:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh_ref_provider_actions{grid-column:4;grid-row:1 / span 2;min-width:0;flex-wrap:nowrap;justify-content:flex-end}.dsh_ref_provider_actions button{flex:0 0 auto;width:auto;white-space:nowrap}.dsh_ref_toggle>span{background:transparent}.dsh_ref_toggle input:checked+span{border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue)}.dsh_ref_toggle input:checked+span:after{background:#fff}.dsh_ref_settings button.is_danger{border-color:rgba(220,38,38,.45);color:#dc2626}.dsh_ref_settings button.is_danger:hover:not(:disabled){border-color:#dc2626;background:rgba(220,38,38,.08);color:#dc2626}body[data-ds-dark-theme] .dsh_ref_settings button.is_danger{border-color:rgba(248,113,113,.55);color:#f87171}body[data-ds-dark-theme] .dsh_ref_settings button.is_danger:hover:not(:disabled){border-color:#f87171;background:rgba(248,113,113,.12);color:#f87171}.dsh_ref_manage_list{max-height:340px;overflow-y:auto;overscroll-behavior:contain;border-color:var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_manage_row{border-color:var(--dsh-ref-line)}.dsh_ref_manage_row:hover{background:var(--dsh-ref-blue-soft)}.dsh_ref_badge{border-color:var(--dsh-ref-blue-line);border-radius:999px;color:var(--dsh-ref-blue)}.dsh_ref_pagination button{border-radius:8px}
@media(max-width:720px){.dsh_ref_picker_row{grid-template-columns:minmax(0,1fr) auto}.dsh_ref_picker_order{grid-column:2}.dsh_ref_picker_limit{justify-content:flex-end}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{padding:18px;border-radius:12px}}
@media(max-width:520px){.dsh_ref_picker_row{grid-template-columns:1fr}.dsh_ref_picker_limit{justify-content:space-between}.dsh_ref_picker_order{grid-column:auto}.dsh_ref_provider{grid-template-columns:34px minmax(0,1fr) auto;grid-template-rows:auto auto auto}.dsh_ref_provider_mark{grid-row:1 / span 3}.dsh_ref_provider h4{grid-column:2;grid-row:1}.dsh_ref_provider>strong{grid-column:2;grid-row:2}.dsh_ref_provider>small{grid-column:2;grid-row:3}.dsh_ref_provider_actions{grid-column:3;grid-row:1 / span 3;flex-direction:column}.dsh_ref_progress_sources{grid-template-columns:1fr 1fr}}
/* Keep explanatory copy readable against DSH's light settings surface. */
.dsh_ref_header p,.dsh_ref_section_head p,.dsh_ref_check small,.dsh_ref_install span,.dsh_ref_picker_limit,.dsh_ref_provider>small,.dsh_ref_field_note{color:#64748b}
body[data-ds-dark-theme] .dsh_ref_header p,body[data-ds-dark-theme] .dsh_ref_section_head p,body[data-ds-dark-theme] .dsh_ref_check small,body[data-ds-dark-theme] .dsh_ref_install span,body[data-ds-dark-theme] .dsh_ref_picker_limit,body[data-ds-dark-theme] .dsh_ref_provider>small,body[data-ds-dark-theme] .dsh_ref_field_note{color:var(--dsw-alias-label-tertiary,#94a3b8)}
.dsh_ref_provider{grid-template-columns:38px minmax(0,1fr);grid-template-rows:auto;align-items:stretch;column-gap:12px;padding:13px 14px}.dsh_ref_provider>.dsh_ref_provider_mark{grid-column:1;grid-row:1;align-self:center}.dsh_ref_provider_content{grid-column:2;display:grid;gap:9px;min-width:0}.dsh_ref_provider_summary{display:grid;grid-template-columns:minmax(120px,1fr) minmax(90px,.45fr) minmax(210px,1fr);align-items:baseline;gap:18px;min-width:0}.dsh_ref_provider_summary h4{grid-column:1;grid-row:auto;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.dsh_ref_provider_summary>strong{display:inline-flex;align-items:baseline;gap:3px;font-family:"Geist Mono",Consolas,monospace;font-size:18px;white-space:nowrap}.dsh_ref_provider_summary>strong span{font-family:Geist,"Segoe UI",sans-serif;font-size:11px;font-weight:600}.dsh_ref_provider_summary>small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:10px;opacity:.78}.dsh_ref_provider_controls{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}.dsh_ref_provider_controls>.dsh_ref_toggle{flex:none;gap:6px;white-space:nowrap}.dsh_ref_provider_controls>.dsh_ref_toggle>span{width:28px;height:16px}.dsh_ref_provider_controls>.dsh_ref_toggle>span:after{top:2px;left:2px}.dsh_ref_provider_controls>.dsh_ref_toggle input:checked+span:after{transform:translateX(12px)}.dsh_ref_provider_controls>.dsh_ref_provider_actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.dsh_ref_provider_controls>.dsh_ref_provider_actions button{min-height:29px;padding:0 10px;font-size:10px;white-space:nowrap}.dsh_ref_provider_error{display:block;margin:0;padding-top:8px;border-top:1px dashed rgba(220,38,38,.28);color:#dc2626;font-size:10px;font-style:normal;line-height:1.45;overflow-wrap:anywhere}
.dsh_ref_storage{display:grid;gap:18px}.dsh_ref_storage_header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:24px}.dsh_ref_storage_header h3{margin:0 0 4px;font-size:17px;letter-spacing:-.02em}.dsh_ref_storage_header p{margin:0;max-width:650px;color:#64748b;font-size:12px;line-height:1.55}.dsh_ref_storage_metric{display:grid;justify-items:end;gap:3px;min-width:116px;padding:8px 12px;border:1px solid var(--dsh-ref-blue-line);border-radius:9px;background:var(--dsh-ref-blue-soft)}.dsh_ref_storage_metric span{color:var(--dsw-alias-label-primary);font-size:10px;font-weight:650;opacity:.78}.dsh_ref_storage_metric strong{color:var(--dsw-alias-label-primary);font-family:"Geist Mono",Consolas,monospace;font-size:15px;line-height:1.25;white-space:nowrap}.dsh_ref_storage_cleanup{display:flex;align-items:flex-end;flex-wrap:wrap;gap:10px;padding-top:16px;border-top:1px solid var(--dsh-ref-line)}.dsh_ref_storage_cleanup>label{display:grid;gap:7px;color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650}.dsh_ref_number_field{display:flex;align-items:center;width:190px;height:36px;overflow:hidden;border:1px solid var(--dsh-ref-line);border-radius:8px;background:var(--dsh-ref-control-surface)}.dsh_ref_number_field:focus-within{outline:2px solid var(--dsh-ref-blue-line);outline-offset:1px}.dsh_ref_number_field input{min-width:0;width:100%;height:100%;padding:0 10px;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px "Geist Mono",Consolas,monospace}.dsh_ref_number_field b{display:grid;place-items:center;align-self:stretch;min-width:42px;border-left:1px solid var(--dsh-ref-line);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650;opacity:.78}.dsh_ref_storage_cleanup>button{height:36px}
body[data-ds-dark-theme] .dsh_ref_storage_header p{color:var(--dsw-alias-label-tertiary,#94a3b8)}
@media(max-width:720px){.dsh_ref_storage_header{grid-template-columns:1fr}.dsh_ref_storage_metric{justify-items:start;justify-self:start}.dsh_ref_provider_summary{grid-template-columns:minmax(100px,1fr) auto}.dsh_ref_provider_summary>small{grid-column:1 / -1}.dsh_ref_provider_controls{align-items:flex-start;flex-direction:column}.dsh_ref_provider_controls>.dsh_ref_provider_actions{justify-content:flex-start}}
@media(max-width:520px){.dsh_ref_provider{grid-template-columns:34px minmax(0,1fr)}.dsh_ref_provider_summary{grid-template-columns:1fr auto;gap:6px 10px}.dsh_ref_provider_controls>.dsh_ref_provider_actions{justify-content:flex-start}.dsh_ref_storage_cleanup{align-items:stretch;flex-direction:column}.dsh_ref_number_field{width:100%}.dsh_ref_storage_cleanup>button{align-self:flex-start}}
/* General is a layout group, not a card. Keep only the actual picker list framed. */
.dsh_ref_workspace>.dsh_ref_panel.dsh_ref_general_settings{padding:0;border:0;border-radius:0;background:transparent}
/* The remaining sections keep their structural outline, but not a filled grey card. */
.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{background:transparent}.dsh_ref_check small.is_warning,.dsh_ref_provider>em,.dsh_ref_error{color:#dc2626}
.dsh_ref_chat{gap:0}.dsh_ref_chat_divider{height:0;margin:20px 0;border-top:1px solid var(--dsh-ref-line)}
@media(prefers-reduced-motion:reduce){.dsh_ref_settings *{transition:none!important}}
`
export function adoptStyles(): void {
  if (document.getElementById('dsh-reference-anything-style')) return
  const style = document.createElement('style'); style.id = 'dsh-reference-anything-style'; style.textContent = css; document.head.appendChild(style)
}

/**
 * Source names are protocol identifiers as well as group labels. Keep the
 * identifiers stable for picking and codecs, and translate only the rendered
 * menu headings owned by this plugin.
 */
export function adoptMenuGroupTitleProjection(t: TranslateNS<typeof REFERENCE_ANYTHING_NS>): () => void {
  const keys: Readonly<Record<string, 'source.conversations' | 'source.files' | 'source.sessions' | 'source.commands' | 'source.skills'>> = {
    'External conversations': 'source.conversations', 'Files and folders': 'source.files', 'DSH sessions': 'source.sessions',
    Commands: 'source.commands', Skills: 'source.skills',
  }
  let projecting = false
  const project = (root: ParentNode): void => {
    if (projecting) return
    const selector = '[role="presentation"][data-source]'
    const headings = root instanceof Element && root.matches(selector) ? [root] : Array.from(root.querySelectorAll(selector))
    projecting = true
    for (const heading of headings) {
      const key = keys[(heading as HTMLElement).dataset.source ?? '']
      if (key !== undefined) heading.textContent = t(key)
    }
    projecting = false
  }
  project(document)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData' && record.target.parentElement !== null) project(record.target.parentElement)
      for (const node of Array.from(record.addedNodes)) if (node instanceof Element) project(node)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => { observer.disconnect() }
}

export interface ConversationSyncActionOptions {
  source: string
  idleLabel: string
  listingLabel(completed: number, total: number): string
  progressLabel(completed: number, total: number): string
  completeLabel: string
  partialLabel: string
  failedLabel: string
  cancelledLabel: string
  start(): Promise<void>
  getStatus(): SyncStatus | undefined
  subscribe(listener: () => void): () => void
}

export interface MenuExpansionOptions {
  sources: readonly string[]
  label: string
  getVisibleLimit(source: string): number
  batchSize?: number
}

/**
 * Re-run the active @ query without changing its visible draft or caret.
 *
 * The host deliberately ignores an `input` event when the detected trigger
 * hit is identical to the open one. Briefly changing the native value creates
 * a superseding generation; restoring it synchronously makes the final
 * generation fetch fresh candidates while the menu remains open.
 */
export function refreshActiveTriggerMenu(): boolean {
  const editor = document.activeElement
  if (!(editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement)) return false
  const start = editor.selectionStart
  const end = editor.selectionEnd
  if (start === null || end === null) return false
  const beforeCaret = editor.value.slice(0, start)
  const trigger = beforeCaret.lastIndexOf('@')
  const whitespace = Math.max(beforeCaret.lastIndexOf(' '), beforeCaret.lastIndexOf('\n'), beforeCaret.lastIndexOf('\t'))
  if (trigger < whitespace) return false

  const original = editor.value
  const changed = `${original.slice(0, start)}\u200B${original.slice(end)}`
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')
  const setValue = (value: string): void => {
    if (descriptor?.set) descriptor.set.call(editor, value)
    else editor.value = value
  }
  setValue(changed)
  editor.setSelectionRange(start + 1, start + 1)
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '\u200B' }))
  setValue(original)
  editor.setSelectionRange(start, end)
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
  return true
}

/**
 * Keep the short @-menu scannable while letting the user reveal a bounded
 * second batch. Candidate retrieval is intentionally capped by the source;
 * this only controls presentation, not search ordering or selection.
 */
export function adoptMenuExpansionProjection(options: MenuExpansionOptions): () => void {
  const selector = '[role="listbox"] [role="presentation"][data-source]'
  const batchSize = options.batchSize ?? 5
  const revealed = new WeakMap<HTMLElement, number>()
  const project = (root: ParentNode): void => {
    const headers = (root instanceof Element && root.matches(selector) ? [root] : Array.from(root.querySelectorAll(selector)))
      .filter(header => options.sources.includes((header as HTMLElement).dataset.source ?? '')) as HTMLElement[]
    for (const header of headers) {
      const source = header.dataset.source ?? ''
      const configuredLimit = Math.max(1, options.getVisibleLimit(source))
      const visibleLimit = revealed.get(header) ?? configuredLimit
      revealed.set(header, visibleLimit)
      const rows: HTMLElement[] = []
      for (let node = header.nextElementSibling; node !== null; node = node.nextElementSibling) {
        if (node.getAttribute('role') === 'presentation') break
        if (node.getAttribute('role') === 'option') rows.push(node as HTMLElement)
      }
      const existing = Array.from(header.parentElement?.querySelectorAll(':scope > [data-dsh-ref-menu-expand]') ?? [])
        .find(node => (node as HTMLElement).dataset.dshRefMenuExpand === source) as HTMLButtonElement | undefined
      if (rows.length <= configuredLimit) {
        revealed.set(header, configuredLimit)
        rows.forEach(row => { row.classList.remove('dsh_ref_menu_collapsed') })
        existing?.remove()
        continue
      }
      rows.forEach((row, index) => { row.classList.toggle('dsh_ref_menu_collapsed', index >= visibleLimit) })
      const button = existing ?? document.createElement('button')
      button.type = 'button'
      button.className = 'dsh_ref_menu_expand'
      button.dataset.dshRefMenuExpand = source
      if (button.textContent !== options.label) button.textContent = options.label
      if (!existing) {
        button.addEventListener('mousedown', event => {
          event.preventDefault()
          event.stopPropagation()
          revealed.set(header, (revealed.get(header) ?? configuredLimit) + batchSize)
          project(header.parentElement ?? document)
        })
      }
      const anchor = rows[Math.min(visibleLimit, rows.length) - 1]
      if (anchor && anchor.nextElementSibling !== button) anchor.after(button)
    }
  }
  project(document)
  const observer = new MutationObserver(() => { project(document) })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect(); for (const button of Array.from(document.querySelectorAll('[data-dsh-ref-menu-expand]'))) button.remove() }
}

/** Add the plugin-owned sync action to the public header contract of its @ source group. */
export function adoptConversationSyncActionProjection(options: ConversationSyncActionOptions): () => void {
  const selector = '[role="listbox"] [role="presentation"][data-source]'
  const buttons = new Set<HTMLButtonElement>()
  let previousRunning = options.getStatus()?.status === 'running'
  const update = (button: HTMLButtonElement): void => {
    const status = options.getStatus()
    const running = status?.status === 'running'
    const listing = running && status.providerProgress.some(row => row.phase === 'listing')
    const listingCompleted = status?.providerProgress.filter(row => row.phase !== 'listing').length ?? 0
    const listingTotal = status?.providerProgress.length ?? 0
    button.disabled = running
    button.classList.toggle('is_listing', listing)
    button.title = status?.error ?? options.idleLabel
    const label = button.querySelector('span')
    if (label) label.textContent = listing ? options.listingLabel(listingCompleted, listingTotal)
      : running ? options.progressLabel(status.completed, status.total)
        : status?.status === 'complete' ? options.completeLabel
          : status?.status === 'partial' ? options.partialLabel
            : status?.status === 'failed' ? options.failedLabel
              : status?.status === 'cancelled' ? options.cancelledLabel
                : options.idleLabel
    const progress = running && status.total > 0 ? Math.min(1, status.completed / status.total) : 0
    button.style.setProperty('--dsh-ref-sync-progress', String(progress))
  }
  const project = (root: ParentNode): void => {
    const headers = (root instanceof Element && root.matches(selector) ? [root] : Array.from(root.querySelectorAll(selector)))
      .filter(header => (header as HTMLElement).dataset.source === options.source)
    for (const header of headers) {
      if (header.querySelector('[data-dsh-ref-sync-all]')) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.tabIndex = -1
      button.className = 'dsh_ref_menu_sync'
      button.dataset.dshRefSyncAll = ''
      button.innerHTML = '<span></span><i aria-hidden="true"></i>'
      const suppress = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      button.addEventListener('pointerdown', event => {
        suppress(event)
        if (!button.disabled) {
          button.disabled = true
          button.classList.add('is_listing')
          const label = button.querySelector('span')
          if (label) label.textContent = options.listingLabel(0, 0)
          void options.start().finally(refresh)
        }
      })
      button.addEventListener('mousedown', suppress)
      button.addEventListener('click', suppress)
      header.append(button)
      buttons.add(button)
      update(button)
    }
  }
  const refresh = (): void => {
    const running = options.getStatus()?.status === 'running'
    for (const button of buttons) {
      if (button.isConnected) update(button)
      else buttons.delete(button)
    }
    if (previousRunning && !running) refreshActiveTriggerMenu()
    previousRunning = running
  }
  project(document)
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of Array.from(record.addedNodes)) if (node instanceof Element) project(node)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = options.subscribe(refresh)
  return () => { observer.disconnect(); unsubscribe(); for (const button of buttons) button.remove() }
}

/** Project opaque dsh-ref mentions in user bubbles without changing logged text. */
export function adoptConversationMentionProjection(): () => void {
  const mention = /@\[([^\n\r]+?)\]\(dsh-ref:[A-Za-z0-9_-]+\)/gu
  const project = (root: ParentNode): void => {
    const rows = root instanceof Element && root.matches('[data-time-hover-root]')
      ? [root]
      : Array.from(root.querySelectorAll('[data-time-hover-root]'))
    for (const row of rows) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      let current: Node | null
      while ((current = walker.nextNode()) !== null) {
        if (current.parentElement?.closest('[data-dsh-ref-projection]') === null && mention.test(current.textContent ?? '')) nodes.push(current as Text)
        mention.lastIndex = 0
      }
      for (const node of nodes) {
        const value = node.data
        const fragment = document.createDocumentFragment()
        let cursor = 0
        for (const match of value.matchAll(mention)) {
          fragment.append(value.slice(cursor, match.index))
          const span = document.createElement('span')
          span.className = 'dsh_ref_message_reference'
          span.dataset.dshRefProjection = 'conversation'
          span.textContent = match[1] ?? ''
          fragment.append(span)
          cursor = match.index + match[0].length
        }
        fragment.append(value.slice(cursor))
        node.replaceWith(fragment)
      }
    }
  }
  project(document)
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of Array.from(record.addedNodes)) {
      if (node instanceof Element) project(node)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}

/** Keep the visible caret aligned with content-sized reference labels. */
export function adoptAdaptiveChipCaret(): () => void {
  const caret = document.createElement('i')
  caret.className = 'dsh_ref_adaptive_caret'
  caret.hidden = true
  document.body.append(caret)
  let frame = 0
  let restartBlink = false
  let composing = false
  const schedule = (restart = false): void => {
    restartBlink ||= restart
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
  }
  const update = (): void => {
    const input = document.activeElement
    if (!(input instanceof HTMLTextAreaElement) || input.selectionStart !== input.selectionEnd) return hide()
    const card = input.closest('[data-composer-card]')
    const backdrop = card?.querySelector('[data-input-backdrop]')
    if (!(backdrop instanceof HTMLElement) || backdrop.querySelector('[data-decoration="chip"]') === null) return hide()
    const range = rangeAtLogicalOffset(backdrop, input.selectionEnd)
    if (range === undefined) return hide()
    const measured = range.getBoundingClientRect()
    const rect = usableCaretRect(measured) ? measured : caretBoundaryRectAtLogicalOffset(backdrop, input.selectionEnd)
    if (rect === undefined) return hide()
    // Read the host caret colour without our own transparent override. On a
    // later update the class is already present; reading first would copy
    // `transparent` onto the painted caret and make it disappear.
    input.classList.remove('dsh_ref_native_caret_hidden')
    const style = getComputedStyle(input)
    const lineHeight = Number.parseFloat(style.lineHeight)
    const fontSize = Number.parseFloat(style.fontSize)
    const resolvedLineHeight = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.2
    const resolvedFontSize = Number.isFinite(fontSize) ? fontSize : resolvedLineHeight
    // Chromium paints a textarea caret against the font's em box, centred in
    // the line box. Snap to physical pixels so a scaled/DPI display does not
    // turn the nominal one-pixel stem into a blurred 1.5px line.
    const ratio = window.devicePixelRatio || 1
    const snap = (value: number): number => Math.round(value * ratio) / ratio
    const caretHeight = snap(Math.min(resolvedLineHeight, resolvedFontSize))
    input.classList.add('dsh_ref_native_caret_hidden')
    caret.hidden = false
    caret.style.left = `${snap(rect.left)}px`
    caret.style.top = `${snap(rect.top + Math.max(0, (resolvedLineHeight - caretHeight) / 2))}px`
    caret.style.width = '1px'
    caret.style.height = `${caretHeight}px`
    // Some embedded Chromium builds expose the computed value as `auto`.
    // Keep the semantic CSS fallback in that case instead of assigning an
    // invalid background colour and making the caret disappear.
    if (style.caretColor !== '' && style.caretColor !== 'auto') caret.style.backgroundColor = style.caretColor
    else caret.style.removeProperty('background-color')
    if (restartBlink && !composing) {
      // Restart from the visible phase without depending on Web Animations,
      // which is missing in some WebView builds used by desktop shells.
      caret.style.animation = 'none'
      void caret.offsetWidth
      caret.style.removeProperty('animation')
    }
    restartBlink = false
  }
  const hide = (): void => {
    document.querySelectorAll('.dsh_ref_native_caret_hidden').forEach(node => node.classList.remove('dsh_ref_native_caret_hidden'))
    caret.hidden = true
  }
  const observer = new MutationObserver(() => schedule())
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  const passiveEvents = ['selectionchange', 'focusout', 'scroll'] as const
  const activeEvents = ['input', 'keyup', 'pointerup', 'focusin'] as const
  const onPassive = (): void => { schedule() }
  const onActive = (): void => { schedule(true) }
  const onCompositionStart = (): void => { composing = true; schedule(true) }
  const onCompositionEnd = (): void => { composing = false; schedule(true) }
  for (const event of passiveEvents) document.addEventListener(event, onPassive, true)
  for (const event of activeEvents) document.addEventListener(event, onActive, true)
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  schedule()
  return () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
    for (const event of passiveEvents) document.removeEventListener(event, onPassive, true)
    for (const event of activeEvents) document.removeEventListener(event, onActive, true)
    document.removeEventListener('compositionstart', onCompositionStart, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
    hide()
    caret.remove()
  }
}

/** Render one shared provider SVG in both the @ menu and the selected chip. */
export function adoptReferenceIconProjection(): () => void {
  const providers = Object.keys(PROVIDER_ICON_MARKER) as ChatProvider[]
  const project = (root: ParentNode): void => {
    // Only rewrite leaf labels. Rewriting a chip's outer span via textContent
    // would destroy the host-owned inner label and make its ::before logo
    // lose to the chip cell's own hidden placeholder pseudo-element.
    const nodes = (root instanceof Element && root.matches('span') ? [root] : Array.from(root.querySelectorAll('span')))
      .filter(node => node.children.length === 0)
    for (const node of nodes) {
      const text = node.textContent ?? ''
      if (text.startsWith(SESSION_ICON_MARKER)) {
        node.textContent = text.slice(SESSION_ICON_MARKER.length).trimStart()
        node.classList.add('dsh_ref_session_icon')
        continue
      }
      const provider = providers.find(key => text.startsWith(PROVIDER_ICON_MARKER[key]))
      if (provider === undefined) continue
      node.textContent = text.slice(PROVIDER_ICON_MARKER[provider].length).trimStart()
      node.classList.add('dsh_ref_projected_icon')
      node.setAttribute('data-dsh-ref-provider-icon', provider)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${PROVIDER_ICON_PATH[provider]}"/></svg>`
      node.setAttribute('style', `${node.getAttribute('style') ?? ''};--dsh-ref-provider-icon:url("data:image/svg+xml,${encodeURIComponent(svg)}")`)
      const chip = node.closest('[data-decoration="chip"]')
      if (chip !== null) {
        chip.classList.add('dsh_ref_conversation_chip')
        chip.setAttribute('data-dsh-ref-provider', provider)
        chip.setAttribute('title', node.textContent ?? '')
      }
    }
  }
  project(document)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData' && record.target.parentElement !== null) project(record.target.parentElement)
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) project(node)
        else if (node.parentElement !== null) project(node.parentElement)
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => { observer.disconnect() }
}

function usableCaretRect(rect: DOMRect): boolean {
  return rect.height > 0 || rect.top !== 0 || rect.left !== 0
}

/**
 * Fallback for Chromium returning an empty collapsed Range at inline
 * boundaries. This notably happens after the trailing space DSH inserts with
 * a reference chip, so both chip edges and ordinary text edges are measured.
 */
function caretBoundaryRectAtLogicalOffset(root: HTMLElement, target: number): Pick<DOMRect, 'left' | 'top'> | undefined {
  let logical = 0
  const visit = (parent: Node): Pick<DOMRect, 'left' | 'top'> | undefined => {
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Element && child.matches('[data-decoration="chip"]')) {
        const chip = child.getBoundingClientRect()
        if (target === logical) return { left: chip.left, top: chip.top }
        logical += 1
        if (target === logical) return { left: chip.right, top: chip.top }
        continue
      }
      if (child instanceof Text) {
        const start = logical
        const end = start + child.data.length
        if (target >= start && target <= end && child.data.length > 0) {
          const range = document.createRange()
          if (target > start) {
            const at = Math.min(child.data.length, target - start)
            range.setStart(child, at - 1)
            range.setEnd(child, at)
            const rect = range.getBoundingClientRect()
            if (usableCaretRect(rect)) return { left: rect.right, top: rect.top }
          }
          if (target < end) {
            const at = Math.max(0, target - start)
            range.setStart(child, at)
            range.setEnd(child, at + 1)
            const rect = range.getBoundingClientRect()
            if (usableCaretRect(rect)) return { left: rect.left, top: rect.top }
          }
        }
        logical = end
        continue
      }
      const found = visit(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  return visit(root)
}

function rangeAtLogicalOffset(root: HTMLElement, target: number): Range | undefined {
  const range = document.createRange()
  let logical = 0
  const visit = (parent: Node): boolean => {
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Element && child.matches('[data-decoration="chip"]')) {
        if (target <= logical) { range.setStartBefore(child); range.collapse(true); return true }
        logical += 1
        if (target <= logical) { range.setStartAfter(child); range.collapse(true); return true }
        continue
      }
      if (child instanceof Text) {
        const end = logical + child.data.length
        if (target <= end) { range.setStart(child, Math.max(0, target - logical)); range.collapse(true); return true }
        logical = end
        continue
      }
      if (visit(child)) return true
    }
    return false
  }
  if (visit(root)) return range
  range.selectNodeContents(root)
  range.collapse(false)
  return range
}
