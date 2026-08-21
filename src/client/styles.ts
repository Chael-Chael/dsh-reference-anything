import type { ChatProvider } from '../wire.ts'
import {
  PICKER_ICON_MARKER, PICKER_ICON_NODES, PICKER_ICON_STROKE_WIDTH, PROVIDER_ICON_MARKER, PROVIDER_ICON_PATH,
  type PickerIconKind,
} from './provider-icons.tsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { REFERENCE_ANYTHING_NS } from './locale.ts'
import { workspacePathIconKind } from './source.ts'

const css = `
  /* Reference Anything customizes the public @ menu and only the visual glyph
     inside matching Composer reference chips. Native text continues to own all
     caret, selection, wrapping, and message geometry. */
[data-composer-card] [role="listbox"]:has([role="presentation"][data-source]){box-sizing:border-box!important;width:100%!important;min-width:0!important;max-width:100%!important;border-radius:22px!important}
[data-composer-card] [role="listbox"] [role="presentation"][data-source]{position:sticky;top:0;z-index:2;box-sizing:border-box;padding-top:6px!important;background:var(--dsw-alias-bg-layer-1,#fff)}
[data-composer-card] [role="listbox"] [role="presentation"][data-source]:not(:first-child){margin-top:8px}
[data-composer-card] [role="listbox"]>[data-dsh-ref-menu-settling]{overflow-anchor:none!important}
[data-composer-card] [role="listbox"]>[data-dsh-ref-menu-settling] [role="option"][aria-selected="false"]:hover{background:transparent!important}
[data-composer-card] [role="listbox"] [role="option"][data-dsh-ref-menu-action]{color:var(--dsw-alias-label-tertiary,#737780)!important}
[data-composer-card] [role="listbox"] [role="option"][data-dsh-ref-menu-action]>span:last-child:not(:first-child){display:none!important}
[data-composer-card] [role="listbox"] .dsh_ref_projected_icon,[data-composer-card] [role="listbox"] .dsh_ref_picker_icon{display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:none;width:16px!important;height:16px!important;line-height:1!important;color:var(--dsw-alias-label-secondary,#5f636b)}
[data-composer-card] [role="listbox"] :is(.dsh_ref_projected_icon,.dsh_ref_picker_icon)>svg{display:block;width:16px;height:16px;overflow:visible}
[data-composer-card] [data-decoration="chip"][data-dsh-ref-chip-icon]>:first-child>svg{visibility:hidden!important}
[data-composer-card] [data-decoration="chip"][data-dsh-ref-chip-icon]>:first-child:after{content:"";position:absolute;top:50%;left:50%;display:block;width:16px;height:16px;transform:translate(-50%,-50%);background:currentColor;-webkit-mask:var(--dsh-ref-chip-icon-mask) center/contain no-repeat;mask:var(--dsh-ref-chip-icon-mask) center/contain no-repeat;pointer-events:none}
.dsh_ref_settings{display:flex;flex-direction:column;gap:18px;width:min(100%,1060px);padding:0 0 36px;color:var(--dsw-alias-label-primary);font-family:Geist,"Segoe UI",sans-serif}.dsh_ref_settings *{box-sizing:border-box}.dsh_ref_header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:0 0 10px}.dsh_ref_header h2{margin:0 0 7px;font-size:28px;line-height:1.1;letter-spacing:-.035em}.dsh_ref_header p{margin:0;max-width:620px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.dsh_ref_settings button{min-height:34px;padding:0 13px;border:1px solid var(--dsw-alias-label-primary);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:650;cursor:pointer}.dsh_ref_settings button:hover:not(:disabled){background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}.dsh_ref_settings button:active:not(:disabled){transform:translateY(1px)}.dsh_ref_settings button:disabled{cursor:not-allowed;opacity:.42}
.dsh_ref_workspace{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent;overflow:hidden}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{margin:0;padding:24px;border:0;border-bottom:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent}.dsh_ref_workspace>.dsh_ref_panel:last-child{border-bottom:0}.dsh_ref_workspace>.dsh_ref_error{margin:20px 24px 0}.dsh_ref_section_head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.dsh_ref_section_head h3{margin:0 0 4px;font-size:17px;letter-spacing:-.02em}.dsh_ref_section_head p{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.45}.dsh_ref_health,.dsh_ref_syncing{display:inline-flex;align-items:center;min-height:25px;padding:0 9px;border:1px solid var(--dsw-alias-label-primary);border-radius:4px;background:transparent;color:var(--dsw-alias-label-primary);font-size:10px;font-weight:700}
.dsh_ref_checklist{display:grid;gap:14px;margin-top:20px}.dsh_ref_check{display:flex;align-items:flex-start;gap:11px;min-height:40px}.dsh_ref_check>span{display:grid;place-items:center;flex:none;width:22px;height:22px;margin-top:2px;border:1px solid var(--dsw-alias-label-primary);border-radius:50%;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;font-weight:800}.dsh_ref_check div{display:grid;min-width:0;gap:2px}.dsh_ref_check strong{font-size:13px}.dsh_ref_check small{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font-size:11px;opacity:.7}.dsh_ref_install{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:20px;padding:14px;border:1px solid var(--dsw-alias-label-primary);background:transparent}.dsh_ref_install>div{display:grid;gap:3px}.dsh_ref_install strong{font-size:12px}.dsh_ref_install span{color:var(--dsw-alias-label-primary);font-size:11px;opacity:.7}.dsh_ref_service_actions{display:flex!important;flex:none;gap:8px}.dsh_ref_error{display:grid;gap:4px;padding:13px;border:1px solid var(--dsw-alias-label-primary);background:transparent;color:var(--dsw-alias-label-primary);font-size:11px}.dsh_ref_skeleton{display:grid;gap:12px;margin-top:20px}.dsh_ref_skeleton i{height:40px;border:1px solid var(--dsw-alias-label-primary);opacity:.25}
.dsh_ref_sources{display:grid;gap:17px}.dsh_ref_provider_grid{display:grid;grid-template-columns:1fr;gap:0;border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_provider{display:grid;grid-template-columns:34px minmax(96px,1fr) minmax(110px,.8fr) minmax(150px,1.3fr) auto;align-items:center;min-width:0;padding:12px 14px;border:0;border-bottom:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent}.dsh_ref_provider:last-child{border-bottom:0}.dsh_ref_provider_top{display:contents}.dsh_ref_provider_mark{display:grid;grid-column:1;place-items:center;width:30px;height:30px;border:1px solid var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary)}.dsh_ref_provider_top>span:not(.dsh_ref_provider_mark):not(.dsh_ref_status_dot){display:none}.dsh_ref_status_dot{display:none}.dsh_ref_provider h4{grid-column:2;margin:0;font-size:13px}.dsh_ref_provider>strong{display:inline-flex;grid-column:3;align-items:baseline;justify-self:start;gap:3px;font-family:"Geist Mono",Consolas,monospace;font-size:18px;white-space:nowrap}.dsh_ref_provider>strong span{font-family:Geist,"Segoe UI",sans-serif;font-size:11px;font-weight:600}.dsh_ref_provider>small{grid-column:4;margin:0;color:var(--dsw-alias-label-primary);font-size:10px;opacity:.7}.dsh_ref_provider>em{display:none}.dsh_ref_provider_foot{display:contents}.dsh_ref_provider_foot>span{display:none}.dsh_ref_provider_actions{grid-column:5;display:flex;gap:6px}.dsh_ref_provider_foot button{min-height:29px;padding:0 10px;font-size:10px}.dsh_ref_empty{padding:20px;border:1px dashed var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:11px;text-align:center}
.dsh_ref_general_settings{display:grid;gap:16px}.dsh_ref_picker_list{border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_picker_row{display:grid;grid-template-columns:minmax(170px,1fr) auto auto auto;align-items:center;gap:14px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-label-primary)}.dsh_ref_picker_row:last-child{border-bottom:0}.dsh_ref_picker_row>label:first-child{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:650}.dsh_ref_picker_row>.dsh_ref_picker_toggle b{font-size:12px}.dsh_ref_picker_row input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-label-primary)}.dsh_ref_picker_limit{display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-primary);font-size:10px}.dsh_ref_picker_limit input{height:30px;width:58px;padding:0 6px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;background:transparent;color:var(--dsw-alias-label-primary);font:11px Geist,"Segoe UI",sans-serif}.dsh_ref_picker_order{display:flex;gap:5px}.dsh_ref_picker_order button{min-width:30px;min-height:30px;padding:0;font-size:15px;line-height:1}
.dsh_ref_sync_settings{display:grid;gap:20px}.dsh_ref_form_grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.dsh_ref_form_grid label{display:grid;gap:6px}.dsh_ref_form_grid label>span{font-size:11px;font-weight:650}.dsh_ref_form_grid input,.dsh_ref_form_grid select{width:100%;height:36px;padding:0 10px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px Geist,"Segoe UI",sans-serif}.dsh_ref_form_grid input:focus,.dsh_ref_form_grid select:focus{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.dsh_ref_form_grid input[aria-invalid=true]{border-style:dashed}.dsh_ref_form_grid select:disabled{opacity:.42}.dsh_ref_toggle{display:flex!important;flex-direction:row!important;align-items:center;gap:8px;cursor:pointer}.dsh_ref_toggle input{position:absolute;opacity:0}.dsh_ref_toggle>span{position:relative;width:32px;height:18px;border:1px solid var(--dsw-alias-label-primary);border-radius:9px;background:transparent}.dsh_ref_toggle>span:after{content:"";position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-label-primary);transition:transform .18s}.dsh_ref_toggle input:checked+span:after{transform:translateX(14px)}.dsh_ref_toggle b{font-size:11px}.dsh_ref_actions{display:flex;flex-wrap:wrap;gap:8px}.dsh_ref_actions .is_primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}.dsh_ref_actions .is_danger{border-style:dashed}.dsh_ref_inline_error,.dsh_ref_auto_note{margin:0;color:var(--dsw-alias-label-primary);font-size:11px}.dsh_ref_auto_note{opacity:.7}.dsh_ref_notice{padding:10px 0;border-bottom:1px solid var(--dsw-alias-label-primary);font-size:11px}
 .dsh_ref_progress_wrap{display:grid;gap:6px;margin-top:4px}.dsh_ref_progress_track{height:6px;border:1px solid var(--dsw-alias-label-primary);background:transparent;overflow:hidden}.dsh_ref_progress_fill{height:100%;background:var(--dsw-alias-label-primary);transition:width .2s ease}.dsh_ref_progress_fill.is_failed,.dsh_ref_progress_fill.is_cancelled{opacity:.4}.dsh_ref_progress_fill.is_partial{opacity:.7}.dsh_ref_progress_label{margin:0;color:var(--dsw-alias-label-primary);font-size:10px;text-transform:lowercase;opacity:.7}.dsh_ref_progress_sources{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px 12px}.dsh_ref_progress_sources span{display:flex;justify-content:space-between;gap:8px;font-size:10px}.dsh_ref_progress_sources i{font-style:normal;opacity:.65}
.dsh_ref_manage{display:grid;gap:15px}.dsh_ref_manage_actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px}.dsh_ref_manage_actions button{white-space:nowrap}.dsh_ref_manage_filters{display:grid;grid-template-columns:1fr 180px;gap:12px}.dsh_ref_manage_filters input,.dsh_ref_manage_filters select{width:100%;height:36px;padding:0 10px;border:1px solid var(--dsw-alias-label-primary);border-radius:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px Geist,"Segoe UI",sans-serif}.dsh_ref_manage_filters input:focus,.dsh_ref_manage_filters select:focus{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.dsh_ref_manage_empty{margin:0;padding:20px;border:1px dashed var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:11px;text-align:center}
.dsh_ref_manage_list{list-style:none;display:grid;gap:0;margin:0;padding:0;max-height:340px;overflow-y:auto;border:1px solid var(--dsw-alias-label-primary)}.dsh_ref_manage_row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 13px;border-bottom:1px solid var(--dsw-alias-label-primary)}.dsh_ref_manage_row:last-child{border-bottom:0}.dsh_ref_manage_main{display:grid;gap:3px;min-width:0}.dsh_ref_manage_title_row{display:flex;align-items:center;flex-wrap:wrap;gap:7px;min-width:0}.dsh_ref_manage_title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px;font-size:13px}.dsh_ref_manage_meta{color:var(--dsw-alias-label-primary);font-size:10px;opacity:.7}.dsh_ref_manage_row_actions{display:flex;align-items:center;gap:8px;flex:none}.dsh_ref_manage_row_actions a,.dsh_ref_manage_row button{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:29px;padding:0 10px;border:1px solid var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-size:10px;text-decoration:none;flex:none}.dsh_ref_manage_row_actions a.is_disabled{cursor:not-allowed;opacity:.4}.dsh_ref_manage_row .is_danger{border-style:dashed}
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
.dsh_ref_update_bar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 14px;border:1px solid var(--dsh-ref-line);border-radius:12px;background:var(--dsh-ref-surface)}.dsh_ref_update_bar.is_available{border-color:var(--dsh-ref-blue-line);background:var(--dsh-ref-blue-soft)}.dsh_ref_update_copy{display:grid;min-width:0;gap:3px}.dsh_ref_update_copy strong{font-size:12px}.dsh_ref_update_copy small{color:#64748b;font-size:10px;line-height:1.45;overflow-wrap:anywhere}.dsh_ref_update_actions{display:flex;align-items:center;flex:none;gap:8px}.dsh_ref_settings .dsh_ref_button{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:0 13px;border:1px solid var(--dsh-ref-line);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;text-decoration:none;transition:background .16s ease,border-color .16s ease,color .16s ease,transform .16s ease}.dsh_ref_settings .dsh_ref_button:hover{border-color:var(--dsh-ref-blue-line);background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue)}.dsh_ref_settings .dsh_ref_button:active{transform:translateY(1px)}.dsh_ref_update_actions .is_primary{border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue);color:#fff}.dsh_ref_update_actions .is_primary:hover:not(:disabled){background:var(--dsh-ref-blue);color:#fff;filter:brightness(.94)}body[data-ds-dark-theme] .dsh_ref_update_copy small{color:var(--dsw-alias-label-tertiary,#94a3b8)}
.dsh_ref_recheck{border-color:var(--dsh-ref-blue-line)!important;color:var(--dsh-ref-blue)!important;background:var(--dsh-ref-blue-soft)!important}.dsh_ref_recheck:hover:not(:disabled){background:var(--dsh-ref-blue)!important;color:#fff!important}
.dsh_ref_workspace{gap:12px;border:0;border-radius:0;background:transparent;overflow:visible}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{padding:20px;border:1px solid var(--dsh-ref-line);border-radius:14px;background:var(--dsh-ref-surface)}.dsh_ref_workspace>.dsh_ref_panel:last-child{border-bottom:1px solid var(--dsh-ref-line)}.dsh_ref_workspace>.dsh_ref_error{margin:0;border-color:rgba(239,68,68,.3);border-radius:12px;background:rgba(239,68,68,.06)}.dsh_ref_notice_layer{position:sticky;top:12px;z-index:20;display:flex;align-items:flex-start;justify-content:center;height:0;margin-bottom:-20px;pointer-events:none}.dsh_ref_notice{width:max-content;max-width:calc(100% - 32px);padding:10px 14px;border:1px solid var(--dsh-ref-blue);border-radius:10px;background:var(--dsh-ref-blue);color:#fff;animation:dsh_ref_notice_drop .18s ease-out both}@keyframes dsh_ref_notice_drop{from{opacity:0;transform:translateY(-12px)}to{opacity:1;transform:translateY(0)}}
.dsh_ref_section_head h3{font-size:16px;font-weight:700;letter-spacing:-.015em}.dsh_ref_section_head p{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));line-height:1.5}.dsh_ref_health,.dsh_ref_syncing{border-color:var(--dsh-ref-blue-line);border-radius:999px;background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue);font-weight:650}.dsh_ref_checklist{gap:13px}.dsh_ref_check>span{border-color:var(--dsh-ref-blue-line);background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue)}.dsh_ref_check small{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));line-height:1.45}
.dsh_ref_install{margin-top:18px;padding:13px 14px;border-color:var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_install span{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary))}.dsh_ref_service_actions button:first-child{border-color:var(--dsh-ref-blue-line);color:var(--dsh-ref-blue)}.dsh_ref_service_actions button.is_primary{border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue);color:#fff}.dsh_ref_service_actions button.is_primary:hover:not(:disabled){filter:brightness(.94)}
.dsh_ref_general_settings{gap:15px}.dsh_ref_render_mode{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px 12px;border:1px solid var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_render_mode>span{display:grid;min-width:0;gap:3px}.dsh_ref_render_mode b{font-size:12px}.dsh_ref_render_mode small{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));font-size:10px;line-height:1.45}.dsh_ref_render_mode select{flex:none;width:132px;height:32px;padding:0 9px;border:1px solid var(--dsh-ref-line);border-radius:7px;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:11px Geist,"Segoe UI",sans-serif}.dsh_ref_render_mode select:focus{outline:2px solid var(--dsh-ref-blue-line);outline-offset:1px}.dsh_ref_picker_list{overflow:hidden;border-color:var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_picker_row{grid-template-columns:minmax(150px,1fr) auto auto auto;gap:12px;padding:10px 12px;border-color:var(--dsh-ref-line)}.dsh_ref_picker_row>label:first-child{color:var(--dsw-alias-label-primary)}.dsh_ref_picker_row input{accent-color:var(--dsh-ref-blue)}.dsh_ref_picker_limit{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary))}.dsh_ref_picker_limit input{border-color:var(--dsh-ref-line);border-radius:7px}.dsh_ref_picker_limit input:focus{outline:2px solid var(--dsh-ref-blue-line);outline-offset:1px}.dsh_ref_picker_limit input[aria-invalid=true]{border-style:dashed}.dsh_ref_picker_order button{min-width:29px;border-color:transparent;background:transparent;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary))}.dsh_ref_picker_order button:hover:not(:disabled){border-color:transparent;background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue)}
.dsh_ref_official_reference{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:13px 14px;border:1px solid var(--dsh-ref-line);border-radius:12px;background:var(--dsh-ref-surface)}.dsh_ref_official_reference>span{display:grid;min-width:0;gap:3px}.dsh_ref_official_reference b{font-size:12px}.dsh_ref_official_reference small{max-width:620px;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));font-size:10px;line-height:1.45}.dsh_ref_official_reference .dsh_ref_official_reference_action{flex:none;min-height:34px;padding:0 13px;border-color:#dc2626;background:#dc2626;color:#fff}.dsh_ref_official_reference .dsh_ref_official_reference_action:hover:not(:disabled){border-color:#b91c1c;background:#b91c1c;color:#fff}.dsh_ref_official_reference .dsh_ref_official_reference_action:active:not(:disabled){transform:translateY(1px)}.dsh_ref_official_reference .dsh_ref_official_reference_action.is_enable{border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue);color:#fff}.dsh_ref_official_reference .dsh_ref_official_reference_action.is_enable:hover:not(:disabled){border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue);color:#fff;filter:brightness(.92)}body[data-ds-dark-theme] .dsh_ref_official_reference .dsh_ref_official_reference_action{border-color:#ef4444;background:#ef4444;color:#fff}body[data-ds-dark-theme] .dsh_ref_official_reference .dsh_ref_official_reference_action:hover:not(:disabled){border-color:#dc2626;background:#dc2626;color:#fff}body[data-ds-dark-theme] .dsh_ref_official_reference .dsh_ref_official_reference_action.is_enable,body[data-ds-dark-theme] .dsh_ref_official_reference .dsh_ref_official_reference_action.is_enable:hover:not(:disabled){border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue);color:#fff}
.dsh_ref_provider_grid{overflow:hidden;border-color:var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_provider{border-color:var(--dsh-ref-line);transition:background .16s ease}.dsh_ref_provider:hover{background:var(--dsh-ref-blue-soft)}.dsh_ref_provider_mark{border-color:var(--dsh-ref-blue-line);border-radius:8px;color:var(--dsh-ref-blue)}.dsh_ref_provider>small{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));opacity:1}.dsh_ref_provider_foot button{border-color:var(--dsh-ref-blue-line);border-radius:7px;color:var(--dsh-ref-blue)}
.dsh_ref_sync_settings{gap:18px}.dsh_ref_form_grid input,.dsh_ref_form_grid select,.dsh_ref_manage_filters input,.dsh_ref_manage_filters select{border-color:var(--dsh-ref-line);border-radius:8px;background:var(--dsh-ref-control-surface)}.dsh_ref_form_grid input:focus,.dsh_ref_form_grid select:focus,.dsh_ref_manage_filters input:focus,.dsh_ref_manage_filters select:focus{outline-color:var(--dsh-ref-blue-line)}.dsh_ref_field_note{margin:0;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-primary));font-size:11px;font-weight:400;line-height:1.45}.dsh_ref_toggle>span{border-color:var(--dsh-ref-blue-line);background:var(--dsh-ref-blue-soft)}.dsh_ref_toggle>span:after{background:var(--dsh-ref-blue)}.dsh_ref_actions .is_primary{border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue);color:#fff}.dsh_ref_actions .is_primary:hover:not(:disabled){background:var(--dsh-ref-blue);color:#fff;filter:brightness(.94)}.dsh_ref_progress_track{border:0;border-radius:999px;background:var(--dsh-ref-blue-soft)}.dsh_ref_progress_fill{border-radius:999px;background:var(--dsh-ref-blue)}
.dsh_ref_viability{display:grid;gap:0;margin-top:12px}.dsh_ref_viability_actions{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:8px}.dsh_ref_picker_limit input{border-color:var(--dsh-ref-line);border-radius:7px;background:transparent}.dsh_ref_picker_limit input:focus{outline:2px solid var(--dsh-ref-blue-line);outline-offset:1px}.dsh_ref_picker_order button{color:var(--dsw-alias-label-primary)}body[data-ds-dark-theme] .dsh_ref_picker_order button{color:var(--dsw-alias-label-tertiary,#cbd5e1)}.dsh_ref_provider{grid-template-columns:34px minmax(130px,1fr) minmax(185px,1.1fr) max-content;grid-template-rows:auto auto;row-gap:2px;padding-inline:14px}.dsh_ref_provider_mark{grid-row:1 / span 2}.dsh_ref_provider h4{grid-row:1 / span 2;align-self:center}.dsh_ref_provider>strong{grid-row:1}.dsh_ref_provider>small{grid-column:3;grid-row:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh_ref_provider_actions{grid-column:4;grid-row:1 / span 2;min-width:0;flex-wrap:nowrap;justify-content:flex-end}.dsh_ref_provider_actions button{flex:0 0 auto;width:auto;white-space:nowrap}.dsh_ref_toggle>span{background:transparent}.dsh_ref_toggle input:checked+span{border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue)}.dsh_ref_toggle input:checked+span:after{background:#fff}.dsh_ref_settings button.is_danger{border-color:rgba(220,38,38,.45);color:#dc2626}.dsh_ref_settings button.is_danger:hover:not(:disabled){border-color:#dc2626;background:rgba(220,38,38,.08);color:#dc2626}body[data-ds-dark-theme] .dsh_ref_settings button.is_danger{border-color:rgba(248,113,113,.55);color:#f87171}body[data-ds-dark-theme] .dsh_ref_settings button.is_danger:hover:not(:disabled){border-color:#f87171;background:rgba(248,113,113,.12);color:#f87171}.dsh_ref_manage_list{max-height:340px;overflow-y:auto;overscroll-behavior:contain;border-color:var(--dsh-ref-line);border-radius:11px;background:var(--dsh-ref-card-surface)}.dsh_ref_manage_row{border-color:var(--dsh-ref-line)}.dsh_ref_manage_row:hover{background:var(--dsh-ref-blue-soft)}.dsh_ref_badge{border-color:var(--dsh-ref-blue-line);border-radius:999px;color:var(--dsh-ref-blue)}.dsh_ref_pagination button{border-radius:8px}
.dsh_ref_manage_row_actions a{border-color:var(--dsh-ref-blue);border-radius:8px;border-style:dashed;color:var(--dsh-ref-blue)}.dsh_ref_manage_row_actions a:hover:not(.is_disabled){border-color:var(--dsh-ref-blue);background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue)}
@media(max-width:720px){.dsh_ref_update_bar{align-items:stretch;flex-direction:column}.dsh_ref_update_actions{flex-wrap:wrap}.dsh_ref_picker_row{grid-template-columns:minmax(0,1fr) auto}.dsh_ref_picker_order{grid-column:2}.dsh_ref_picker_limit{justify-content:flex-end}.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{padding:18px;border-radius:12px}}
@media(max-width:520px){.dsh_ref_picker_row{grid-template-columns:1fr}.dsh_ref_picker_limit{justify-content:space-between}.dsh_ref_picker_order{grid-column:auto}.dsh_ref_official_reference{align-items:flex-start;flex-direction:column}.dsh_ref_provider{grid-template-columns:34px minmax(0,1fr) auto;grid-template-rows:auto auto auto}.dsh_ref_provider_mark{grid-row:1 / span 3}.dsh_ref_provider h4{grid-column:2;grid-row:1}.dsh_ref_provider>strong{grid-column:2;grid-row:2}.dsh_ref_provider>small{grid-column:2;grid-row:3}.dsh_ref_provider_actions{grid-column:3;grid-row:1 / span 3;flex-direction:column}.dsh_ref_progress_sources{grid-template-columns:1fr 1fr}}
/* Keep explanatory copy readable against DSH's light settings surface. */
.dsh_ref_header p,.dsh_ref_section_head p,.dsh_ref_check small,.dsh_ref_install span,.dsh_ref_picker_limit,.dsh_ref_provider>small,.dsh_ref_field_note,.dsh_ref_render_mode small,.dsh_ref_official_reference small{color:#64748b}
body[data-ds-dark-theme] .dsh_ref_header p,body[data-ds-dark-theme] .dsh_ref_section_head p,body[data-ds-dark-theme] .dsh_ref_check small,body[data-ds-dark-theme] .dsh_ref_install span,body[data-ds-dark-theme] .dsh_ref_picker_limit,body[data-ds-dark-theme] .dsh_ref_provider>small,body[data-ds-dark-theme] .dsh_ref_field_note,body[data-ds-dark-theme] .dsh_ref_render_mode small,body[data-ds-dark-theme] .dsh_ref_official_reference small{color:var(--dsw-alias-label-tertiary,#94a3b8)}
.dsh_ref_header_brand{display:flex;align-items:flex-start;gap:14px}.dsh_ref_header_brand img{flex:none;width:42px;height:42px;object-fit:contain;border-radius:10px}
.dsh_ref_provider{grid-template-columns:38px minmax(0,1fr);grid-template-rows:auto;align-items:stretch;column-gap:12px;padding:13px 14px}.dsh_ref_provider>.dsh_ref_provider_mark{grid-column:1;grid-row:1;align-self:center}.dsh_ref_provider_content{grid-column:2;display:grid;gap:9px;min-width:0}.dsh_ref_provider_summary{display:grid;grid-template-columns:minmax(120px,1fr) minmax(90px,.45fr) minmax(210px,1fr);align-items:baseline;gap:18px;min-width:0}.dsh_ref_provider_summary h4{grid-column:1;grid-row:auto;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.dsh_ref_provider_summary>strong{display:inline-flex;align-items:baseline;gap:3px;font-family:"Geist Mono",Consolas,monospace;font-size:18px;white-space:nowrap}.dsh_ref_provider_summary>strong span{font-family:Geist,"Segoe UI",sans-serif;font-size:11px;font-weight:600}.dsh_ref_provider_summary>small{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:10px;opacity:.78}.dsh_ref_provider_controls{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}.dsh_ref_provider_controls>.dsh_ref_toggle{flex:none;gap:6px;white-space:nowrap}.dsh_ref_provider_controls>.dsh_ref_toggle>span{width:28px;height:16px}.dsh_ref_provider_controls>.dsh_ref_toggle>span:after{top:2px;left:2px}.dsh_ref_provider_controls>.dsh_ref_toggle input:checked+span:after{transform:translateX(12px)}.dsh_ref_provider_controls>.dsh_ref_provider_actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.dsh_ref_provider_controls>.dsh_ref_provider_actions button{min-height:29px;padding:0 10px;font-size:10px;white-space:nowrap}.dsh_ref_provider_error{display:block;margin:0;padding-top:8px;border-top:1px dashed rgba(220,38,38,.28);color:#dc2626;font-size:10px;font-style:normal;line-height:1.45;overflow-wrap:anywhere}
.dsh_ref_storage{display:grid;gap:18px}.dsh_ref_storage_header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:24px}.dsh_ref_storage_header h3{margin:0 0 4px;font-size:17px;letter-spacing:-.02em}.dsh_ref_storage_header p{margin:0;max-width:650px;color:#64748b;font-size:12px;line-height:1.55}.dsh_ref_storage_metric{display:grid;justify-items:end;gap:3px;min-width:116px;padding:8px 12px;border:1px solid var(--dsh-ref-blue-line);border-radius:9px;background:var(--dsh-ref-blue-soft)}.dsh_ref_storage_metric span{color:var(--dsw-alias-label-primary);font-size:10px;font-weight:650;opacity:.78}.dsh_ref_storage_metric strong{color:var(--dsw-alias-label-primary);font-family:"Geist Mono",Consolas,monospace;font-size:15px;line-height:1.25;white-space:nowrap}.dsh_ref_storage_cleanup{display:flex;align-items:flex-end;flex-wrap:wrap;gap:10px;padding-top:16px;border-top:1px solid var(--dsh-ref-line)}.dsh_ref_storage_cleanup>label{display:grid;gap:7px;color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650}.dsh_ref_number_field{display:flex;align-items:center;width:190px;height:36px;overflow:hidden;border:1px solid var(--dsh-ref-line);border-radius:8px;background:var(--dsh-ref-control-surface)}.dsh_ref_number_field:focus-within{outline:2px solid var(--dsh-ref-blue-line);outline-offset:1px}.dsh_ref_number_field input{min-width:0;width:100%;height:100%;padding:0 10px;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:12px "Geist Mono",Consolas,monospace}.dsh_ref_number_field b{display:grid;place-items:center;align-self:stretch;min-width:42px;border-left:1px solid var(--dsh-ref-line);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:650;opacity:.78}.dsh_ref_storage_cleanup>button{height:36px}
body[data-ds-dark-theme] .dsh_ref_storage_header p{color:var(--dsw-alias-label-tertiary,#94a3b8)}
@media(max-width:720px){.dsh_ref_storage_header{grid-template-columns:1fr}.dsh_ref_storage_metric{justify-items:start;justify-self:start}.dsh_ref_provider_summary{grid-template-columns:minmax(100px,1fr) auto}.dsh_ref_provider_summary>small{grid-column:1 / -1}.dsh_ref_provider_controls{align-items:flex-start;flex-direction:column}.dsh_ref_provider_controls>.dsh_ref_provider_actions{justify-content:flex-start}}
@media(max-width:520px){.dsh_ref_provider{grid-template-columns:34px minmax(0,1fr)}.dsh_ref_provider_summary{grid-template-columns:1fr auto;gap:6px 10px}.dsh_ref_provider_controls>.dsh_ref_provider_actions{justify-content:flex-start}.dsh_ref_storage_cleanup{align-items:stretch;flex-direction:column}.dsh_ref_number_field{width:100%}.dsh_ref_storage_cleanup>button{align-self:flex-start}}
/* General is a layout group, not a card. Keep only the actual picker list framed. */
.dsh_ref_workspace>.dsh_ref_panel.dsh_ref_general_settings{padding:0;border:0;border-radius:0;background:transparent}
/* The remaining sections keep their structural outline, but not a filled grey card. */
.dsh_ref_workspace>.dsh_ref_panel,.dsh_ref_workspace>.dsh_ref_sources{background:transparent}.dsh_ref_check>span.is_ready{border-color:rgba(22,163,74,.35);background:rgba(22,163,74,.1);color:#16a34a}.dsh_ref_check>span.is_neutral{border-color:rgba(100,116,139,.35);background:rgba(100,116,139,.1);color:#64748b}.dsh_ref_check>span.is_error{border-color:rgba(220,38,38,.35);background:rgba(220,38,38,.08);color:#dc2626}.dsh_ref_check small.is_warning,.dsh_ref_provider>em,.dsh_ref_error{color:#dc2626}
.dsh_ref_health.is_ready{border-color:rgba(22,163,74,.35);background:rgba(22,163,74,.1);color:#16a34a}.dsh_ref_check_body{flex:1}.dsh_ref_check_actions{display:flex!important;align-items:center;flex-wrap:wrap;gap:7px!important;margin-top:6px}.dsh_ref_check_actions>button{min-height:28px;padding:0 9px;border-color:var(--dsh-ref-blue-line);border-radius:7px;color:var(--dsh-ref-blue);font-size:10px}.dsh_ref_check_profile{display:flex!important;grid-template-columns:none!important;align-items:center;gap:7px!important}.dsh_ref_check_profile select{height:29px;max-width:220px;padding:0 8px;border:1px solid var(--dsh-ref-line);border-radius:7px;background:var(--dsh-ref-control-surface);color:var(--dsw-alias-label-primary);font:11px Geist,"Segoe UI",sans-serif}.dsh_ref_store_fallback{margin:14px 0 0;padding:10px 12px;border:1px solid rgba(220,38,38,.3);border-radius:9px;background:rgba(220,38,38,.06);color:#dc2626;font-size:11px}.dsh_ref_store_fallback a{color:inherit;font-weight:700}.dsh_ref_setup_step{margin:14px 0 0;padding:9px 11px;border:1px solid var(--dsh-ref-blue-line);border-radius:9px;background:var(--dsh-ref-blue-soft);color:var(--dsh-ref-blue);font-size:11px;font-weight:650}
.dsh_ref_chat{gap:0}.dsh_ref_chat_divider{height:0;margin:20px 0;border-top:1px solid var(--dsh-ref-line)}
@media(prefers-reduced-motion:reduce){.dsh_ref_settings *{transition:none!important}}
`

export function adoptStyles(): void {
  if (document.getElementById('dsh-reference-anything-style')) return
  const style = document.createElement('style')
  style.id = 'dsh-reference-anything-style'
  style.textContent = css
  document.head.appendChild(style)
}

interface MenuPointerSnapshot {
  composer: Element
  viewport: HTMLElement
  scrollTop: number
  capturedAt: number
  clientX: number
  clientY: number
}

const PRECLICK_HOVER_MAX_AGE_MS = 750
const PRECLICK_PICK_MAX_AGE_MS = 250
const PRECLICK_MAX_AUTOSCROLL_PX = 48
let hoveredMenuSnapshot: MenuPointerSnapshot | undefined
let pendingMenuPickSnapshot: MenuPointerSnapshot | undefined

/**
 * Remember the last user-owned menu position before a clipped option can be
 * scrolled into view by click actionability. High-frequency pointer handling
 * reads only scrollTop; no layout measurement occurs on this path.
 */
export function adoptMenuViewportTracking(): () => void {
  let wheelFrame: number | undefined
  const resolve = (target: EventTarget | null): Omit<MenuPointerSnapshot, 'capturedAt' | 'clientX' | 'clientY'> | undefined => {
    const element = target instanceof Element ? target : null
    const listbox = element?.closest('[data-composer-card] [role="listbox"]')
    const composer = listbox?.closest('[data-composer-card]')
    const viewport = listbox?.firstElementChild
    return composer !== null && composer !== undefined && viewport instanceof HTMLElement
      ? { composer, viewport, scrollTop: viewport.scrollTop }
      : undefined
  }
  const record = (event: PointerEvent | WheelEvent): void => {
    const current = resolve(event.target)
    if (current === undefined) return
    hoveredMenuSnapshot = {
      ...current,
      capturedAt: performance.now(),
      clientX: event.clientX,
      clientY: event.clientY,
    }
  }
  const onPointerMove = (event: PointerEvent): void => {
    const now = performance.now()
    if (hoveredMenuSnapshot !== undefined && now - hoveredMenuSnapshot.capturedAt < 16) return
    record(event)
  }
  const onWheel = (event: WheelEvent): void => {
    if (wheelFrame !== undefined) cancelAnimationFrame(wheelFrame)
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = undefined
      record(event)
    })
  }
  const onPointerDown = (event: PointerEvent): void => {
    const current = resolve(event.target)
    if (current === undefined || !(event.target instanceof Element) || event.target.closest('[role="option"]') === null) return
    const now = performance.now()
    const hovered = hoveredMenuSnapshot
    const canRestorePreclick = hovered !== undefined
      && hovered.composer === current.composer
      && hovered.viewport === current.viewport
      && now - hovered.capturedAt <= PRECLICK_HOVER_MAX_AGE_MS
      && Math.abs(current.scrollTop - hovered.scrollTop) <= PRECLICK_MAX_AUTOSCROLL_PX
    pendingMenuPickSnapshot = canRestorePreclick
      ? { ...hovered, capturedAt: now, clientX: event.clientX, clientY: event.clientY }
      : { ...current, capturedAt: now, clientX: event.clientX, clientY: event.clientY }
  }
  const clearForKeyboard = (): void => {
    hoveredMenuSnapshot = undefined
    pendingMenuPickSnapshot = undefined
  }
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  document.addEventListener('wheel', onWheel, { capture: true, passive: true })
  document.addEventListener('keydown', clearForKeyboard, { capture: true })
  return () => {
    document.removeEventListener('pointermove', onPointerMove, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('wheel', onWheel, true)
    document.removeEventListener('keydown', clearForKeyboard, true)
    if (wheelFrame !== undefined) cancelAnimationFrame(wheelFrame)
    hoveredMenuSnapshot = undefined
    pendingMenuPickSnapshot = undefined
  }
}

/**
 * Source names double as stable codec identifiers. Translate only headings
 * rendered inside the native @ menu.
 */
export function adoptMenuGroupTitleProjection(t: TranslateNS<typeof REFERENCE_ANYTHING_NS>): () => void {
  const keys: Readonly<Record<string, 'source.conversations' | 'source.files' | 'source.sessions' | 'source.agents' | 'source.commands' | 'source.skills'>> = {
    'External conversations': 'source.conversations',
    'Files and folders': 'source.files',
    'DSH sessions': 'source.sessions',
    'Local agent conversations': 'source.agents',
    Commands: 'source.commands',
    Skills: 'source.skills',
  }
  const normalizeLabel = (value: string): string => value.replace(/\s/gu, '')
  const actionLabels = new Set([
    normalizeLabel(`${t('menu.collapse')}${t('menu.collapseDetail')}`),
    ...Array.from({ length: 5 }, (_, index) => normalizeLabel(`${t('menu.showMore', { count: index + 1 })}${t('menu.showMoreDetail')}`)),
  ])
  let projecting = false
  const project = (root: ParentNode): void => {
    if (projecting) return
    const menuSelector = '[data-composer-card] [role="listbox"]'
    const menus = new Set<Element>()
    if (root instanceof Element) {
      if (root.matches(menuSelector)) menus.add(root)
      const containingMenu = root.closest(menuSelector)
      if (containingMenu !== null) menus.add(containingMenu)
    }
    for (const menu of Array.from(root.querySelectorAll(menuSelector))) menus.add(menu)
    projecting = true
    for (const menu of menus) {
      for (const heading of Array.from(menu.querySelectorAll<HTMLElement>('[role="presentation"][data-source]'))) {
        const key = keys[heading.dataset.source ?? '']
        if (key !== undefined && heading.textContent !== t(key)) heading.textContent = t(key)
      }
      for (const option of Array.from(menu.querySelectorAll<HTMLElement>('[role="option"]'))) {
        if (actionLabels.has(normalizeLabel(option.textContent ?? ''))) option.dataset.dshRefMenuAction = ''
        else delete option.dataset.dshRefMenuAction
      }
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

/**
 * Re-run the active @ query after a source-owned menu action. Capture the
 * viewport before the native controller closes the menu, reopen it in a
 * microtask (before the next paint), and restore the previous scroll anchor as
 * asynchronous source results settle.
 */
export function refreshActiveTriggerMenu(source?: string, anchor?: 'first' | 'last' | 'viewport'): boolean {
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
  const composer = editor.closest('[data-composer-card]')
  const now = performance.now()
  let snapshot: MenuViewportSnapshot | undefined
  if (anchor !== undefined) {
    snapshot = captureMenuViewport(composer, anchor === 'viewport' ? undefined : source, anchor === 'last' ? 'last' : 'first')
    if (snapshot !== undefined) {
      const lease: MenuAnchorLease = {
        composer, editor, source, value: original, snapshot, expiresAt: now + ACTION_ANCHOR_LEASE_MS,
      }
      anchorLease = lease
      composer?.addEventListener('wheel', () => {
        if (anchorLease === lease) anchorLease = undefined
      }, { capture: true, once: true })
    }
  } else if (
    anchorLease?.composer === composer
    && anchorLease.editor === editor
    && anchorLease.source === source
    && anchorLease.value === original
    && anchorLease.expiresAt > now
  ) {
    snapshot = anchorLease.snapshot
  } else {
    anchorLease = undefined
    snapshot = captureMenuViewport(composer, source, 'first')
  }
  queueMicrotask(() => {
    const stopPreserving = snapshot === undefined ? undefined : preserveMenuViewport(snapshot)
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')
    const setValue = (value: string): void => {
      if (descriptor?.set) descriptor.set.call(editor, value)
      else editor.value = value
    }
    setValue(`${original.slice(0, start)}\u200B${original.slice(end)}`)
    editor.setSelectionRange(start + 1, start + 1)
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '\u200B' }))
    setValue(original)
    editor.setSelectionRange(start, end)
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
    stopPreserving?.arm()
  })
  return true
}

/**
 * Apply a native menu-store mutation after a handled pick closes the menu,
 * while retaining the viewport captured before that close. Unlike
 * {@link refreshActiveTriggerMenu}, this never edits the Composer value and
 * therefore does not launch a new all-source candidate generation.
 */
export function mutateActiveTriggerMenu(
  source: string,
  anchor: 'first' | 'last' | 'viewport' | undefined,
  mutate: () => void,
): void {
  const editor = document.activeElement
  const composer = editor instanceof Element
    ? editor.closest('[data-composer-card]')
    : document.querySelector('[data-composer-card]:has([role="listbox"])')
  const pointerSnapshot = anchor === 'viewport' ? consumeMenuPickSnapshot(composer) : undefined
  const snapshot = pointerSnapshot ?? (anchor === undefined
    ? undefined
    : captureMenuViewport(composer, anchor === 'viewport' ? undefined : source, anchor === 'last' ? 'last' : 'first'))
  queueMicrotask(() => {
    // The host keys rows by source + index. Expanding near the viewport edge
    // therefore reuses the hovered action button as the first appended row.
    // Quiet that inherited hover (and native scroll anchoring) until the user
    // moves the pointer, so the cached in-place update paints only once.
    if (anchor === 'viewport') quietRecycledMenuHover(composer, pointerSnapshot)
    const preservation = snapshot === undefined ? undefined : preserveMenuViewport(snapshot)
    mutate()
    preservation?.arm()
  })
}

function consumeMenuPickSnapshot(composer: Element | null): MenuViewportSnapshot | undefined {
  const candidate = pendingMenuPickSnapshot
  pendingMenuPickSnapshot = undefined
  if (
    composer === null
    || candidate === undefined
    || candidate.composer !== composer
    || !candidate.viewport.isConnected
    || performance.now() - candidate.capturedAt > PRECLICK_PICK_MAX_AGE_MS
  ) return undefined
  return {
    composer,
    scrollTop: candidate.scrollTop,
    pointerX: candidate.clientX,
    pointerY: candidate.clientY,
  }
}

const quietMenuUpdates = new WeakMap<HTMLElement, () => void>()

function quietRecycledMenuHover(composer: Element | null, pointer?: MenuViewportSnapshot): void {
  const viewport = composer?.querySelector('[role="listbox"]')?.firstElementChild
  if (!(viewport instanceof HTMLElement)) return
  quietMenuUpdates.get(viewport)?.()
  viewport.dataset.dshRefMenuSettling = ''
  const origin = pointer?.pointerX === undefined || pointer.pointerY === undefined
    ? undefined
    : { x: pointer.pointerX, y: pointer.pointerY }
  let released = false
  let ready = false
  let moved = false
  const onPointerMove = (event: PointerEvent): void => {
    if (origin === undefined || Math.abs(event.clientX - origin.x) >= 1 || Math.abs(event.clientY - origin.y) >= 1) moved = true
    if (ready && moved) release()
  }
  const release = (): void => {
    if (released) return
    released = true
    delete viewport.dataset.dshRefMenuSettling
    document.removeEventListener('pointermove', onPointerMove, true)
    clearTimeout(expiry)
    quietMenuUpdates.delete(viewport)
  }
  quietMenuUpdates.set(viewport, release)
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  const expiry = setTimeout(release, 5_000)
  afterTwoFrames(() => {
    ready = true
    if (moved) release()
  })
}

function afterTwoFrames(callback: () => void): void {
  if (typeof requestAnimationFrame !== 'function') {
    setTimeout(callback, 32)
    return
  }
  requestAnimationFrame(() => { requestAnimationFrame(callback) })
}

interface MenuViewportSnapshot {
  composer: Element
  scrollTop: number
  pointerX?: number
  pointerY?: number
  anchorId?: string
  anchorSource?: string
  anchorEdge?: 'first' | 'last'
  anchorOffset?: number
}

interface MenuAnchorLease {
  composer: Element | null
  editor: HTMLTextAreaElement | HTMLInputElement
  source?: string
  value: string
  snapshot: MenuViewportSnapshot
  expiresAt: number
}

const ACTION_ANCHOR_LEASE_MS = 5 * 60_000
let anchorLease: MenuAnchorLease | undefined

function captureMenuViewport(
  composer: Element | null,
  source?: string,
  edge: 'first' | 'last' = 'first',
): MenuViewportSnapshot | undefined {
  if (composer === null) return undefined
  const listbox = composer.querySelector('[role="listbox"]')
  const viewport = listbox?.firstElementChild
  if (!(viewport instanceof HTMLElement)) return undefined
  const viewportRect = viewport.getBoundingClientRect()
  const options = Array.from(viewport.querySelectorAll<HTMLElement>('[role="option"][id]'))
  const sourceAnchor = source === undefined ? undefined : sourceEdgeOption(viewport, source, edge)
  const anchor = sourceAnchor ?? options.find(option => {
    const rect = option.getBoundingClientRect()
    return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
  }) ?? options.find(option => option.getBoundingClientRect().bottom > viewportRect.top)
  return {
    composer,
    scrollTop: viewport.scrollTop,
    ...(anchor === undefined ? {} : {
      anchorId: anchor.id,
      ...(sourceAnchor === undefined ? {} : { anchorSource: source, anchorEdge: edge }),
      anchorOffset: anchor.getBoundingClientRect().top - viewportRect.top,
    }),
  }
}

function sourceEdgeOption(viewport: Element, source: string, edge: 'first' | 'last'): HTMLElement | undefined {
  const heading = Array.from(viewport.querySelectorAll<HTMLElement>('[role="presentation"][data-source]'))
    .find(candidate => candidate.dataset.source === source)
  if (heading === undefined) return undefined
  const options: HTMLElement[] = []
  let sibling = heading.nextElementSibling
  while (sibling !== null && sibling.getAttribute('role') !== 'presentation') {
    if (sibling instanceof HTMLElement && sibling.getAttribute('role') === 'option') options.push(sibling)
    sibling = sibling.nextElementSibling
  }
  return edge === 'first' ? options.at(0) : options.at(-1)
}

/** Preserve a remounted native menu until its async candidate generation lands. */
function preserveMenuViewport(snapshot: MenuViewportSnapshot): { arm(): void } {
  let armed = false
  let disposed = false
  let forceUntil = 0
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const restore = (): void => {
    if (!armed || disposed) return
    const listbox = snapshot.composer.querySelector('[role="listbox"]')
    const viewport = listbox?.firstElementChild
    if (!(viewport instanceof HTMLElement)) return
    const force = performance.now() < forceUntil
    if (force || viewport.scrollTop === 0) viewport.scrollTop = snapshot.scrollTop
    if (snapshot.anchorId === undefined || snapshot.anchorOffset === undefined) return
    const anchor = snapshot.anchorSource === undefined || snapshot.anchorEdge === undefined
      ? document.getElementById(snapshot.anchorId)
      : sourceEdgeOption(viewport, snapshot.anchorSource, snapshot.anchorEdge)
    if (!(anchor instanceof HTMLElement) || !viewport.contains(anchor)) return
    const delta = anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - snapshot.anchorOffset
    if (force && Number.isFinite(delta) && Math.abs(delta) >= 1) {
      ensureAnchorScrollRange(viewport, viewport.scrollTop + delta)
      viewport.scrollTop += delta
    }
  }
  const schedule = (): void => {
    forceUntil = performance.now() + 180
    restore()
    for (const delay of [0, 16, 50, 120, 200]) timers.push(setTimeout(restore, delay))
  }
  const observer = new MutationObserver(() => { schedule() })
  observer.observe(snapshot.composer, { childList: true, subtree: true })
  const expiry = setTimeout(() => {
    disposed = true
    observer.disconnect()
    for (const timer of timers) clearTimeout(timer)
  }, 5_000)
  return {
    arm() {
      armed = true
      schedule()
      // Keep the expiry timer live even if the first generation is immediate.
      void expiry
    },
  }
}

function ensureAnchorScrollRange(viewport: HTMLElement, desiredScrollTop: number): void {
  const applied = Number.parseFloat(viewport.dataset.dshRefAnchorPadding ?? '0') || 0
  const computedPadding = Number.parseFloat(getComputedStyle(viewport).paddingBottom) || 0
  const basePadding = Math.max(0, computedPadding - applied)
  const naturalMaximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight - applied)
  const required = Math.max(0, desiredScrollTop - naturalMaximum)
  if (Math.abs(required - applied) < 0.5) return
  viewport.dataset.dshRefAnchorPadding = String(required)
  viewport.style.setProperty('padding-bottom', `${String(basePadding + required)}px`, 'important')
}

/** Replace @ menu markers and paint matching Composer chips in the same glyph set. */
export function adoptReferenceIconProjection(): () => void {
  const providers = Object.keys(PROVIDER_ICON_MARKER) as ChatProvider[]
  const pickerKinds = Object.keys(PICKER_ICON_MARKER) as PickerIconKind[]
  const providerMasks = Object.fromEntries(providers.map(provider => [provider, providerIconMask(PROVIDER_ICON_PATH[provider])])) as Record<ChatProvider, string>
  const pickerMasks = Object.fromEntries(pickerKinds.map(kind => [kind, pickerIconMask(kind)])) as Record<PickerIconKind, string>
  const project = (root: ParentNode): void => {
    const selector = '[data-composer-card] [role="listbox"]'
    const menus = new Set<Element>()
    if (root instanceof Element) {
      if (root.matches(selector)) menus.add(root)
      const containingMenu = root.closest(selector)
      if (containingMenu !== null) menus.add(containingMenu)
    }
    for (const menu of Array.from(root.querySelectorAll(selector))) menus.add(menu)
    for (const menu of menus) {
      const walker = document.createTreeWalker(menu, NodeFilter.SHOW_ELEMENT)
      let node = walker.nextNode()
      while (node !== null) {
        if (node instanceof HTMLElement && node.childElementCount === 0) {
          const text = node.textContent ?? ''
          const provider = providers.find(item => text.includes(PROVIDER_ICON_MARKER[item]))
          if (provider !== undefined) {
            node.replaceChildren(createProviderIcon(PROVIDER_ICON_PATH[provider]))
            node.classList.remove('dsh_ref_picker_icon')
            node.classList.add('dsh_ref_projected_icon')
            node.dataset.dshRefMenuIcon = provider
          } else {
            const kind = pickerKinds.find(item => text.includes(PICKER_ICON_MARKER[item]))
            if (kind !== undefined) {
              node.replaceChildren(createPickerIcon(kind))
              node.classList.remove('dsh_ref_projected_icon')
              node.classList.add('dsh_ref_picker_icon')
              node.dataset.dshRefMenuIcon = kind
            }
          }
        }
        node = walker.nextNode()
      }
    }
    projectComposerChips(root, providerMasks, pickerMasks)
  }
  project(document)
  const observer = new MutationObserver(records => {
    const roots = new Set<ParentNode>()
    const queueProjection = (element: Element): void => {
      roots.add(element.closest('[data-composer-card] [role="listbox"]') ?? element)
    }
    for (const record of records) {
      if (record.type === 'characterData' && record.target.parentElement !== null) queueProjection(record.target.parentElement)
      if (record.type === 'attributes' && record.target instanceof Element) queueProjection(record.target)
      // React keys native menu rows by source + index. When refreshed results
      // move to the front, it reuses the icon span and replaces our SVG with a
      // marker Text node. Project the mutation target so that reused spans are
      // reconciled before the next paint, even when no Element was added.
      if (record.type === 'childList' && record.target instanceof Element) queueProjection(record.target)
    }
    for (const root of roots) project(root)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-reference-appearance'] })
  return () => { observer.disconnect() }
}

const CHIP_PROVIDER_LABEL: Readonly<Record<ChatProvider, string>> = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek', grok: 'Grok', kimi: 'Kimi',
}
const LOCAL_AGENT_CHIP_LABELS = ['Claude Code', 'Codex', 'Cursor', 'Qoder', 'Reasonix', 'OpenClaw', 'Kimi CLI', 'Grok Build', 'Hermes', 'Gemini CLI', 'Pi', 'opencode', 'mimocode', 'zcode'] as const

function projectComposerChips(
  root: ParentNode,
  providerMasks: Readonly<Record<ChatProvider, string>>,
  pickerMasks: Readonly<Record<PickerIconKind, string>>,
): void {
  const selector = '[data-composer-card] [data-decoration="chip"][data-reference-appearance]'
  const chips = new Set<HTMLElement>()
  if (root instanceof Element) {
    const chip = root.matches(selector) ? root : root.closest(selector)
    if (chip instanceof HTMLElement) chips.add(chip)
  }
  for (const chip of Array.from(root.querySelectorAll(selector))) if (chip instanceof HTMLElement) chips.add(chip)
  for (const chip of chips) {
    const label = (chip.textContent ?? '').trim().replace(/^@/u, '')
    const appearance = chip.dataset.referenceAppearance
    if (appearance === 'session') {
      const referenceSource = chip.dataset.referenceSource
      if (referenceSource === 'Local agent conversations' || referenceSource === 'local-agent') {
        applyChipIcon(chip, 'agent', pickerMasks.agent)
        continue
      }
      if (LOCAL_AGENT_CHIP_LABELS.some(agent => label.startsWith(`${agent}·`))) {
        applyChipIcon(chip, 'agent', pickerMasks.agent)
        continue
      }
      const provider = (Object.keys(CHIP_PROVIDER_LABEL) as ChatProvider[])
        .find(item => label.startsWith(`${CHIP_PROVIDER_LABEL[item]}·`))
      if (provider !== undefined) applyChipIcon(chip, provider, providerMasks[provider])
      else applyChipIcon(chip, 'session', pickerMasks.session)
    } else if (appearance === 'file') {
      const kind = workspacePathIconKind(label, 'file')
      applyChipIcon(chip, kind, pickerMasks[kind])
    } else {
      clearChipIcon(chip)
    }
  }
}

function applyChipIcon(chip: HTMLElement, kind: string, mask: string): void {
  if (chip.dataset.dshRefChipIcon === kind && chip.style.getPropertyValue('--dsh-ref-chip-icon-mask') === mask) return
  chip.dataset.dshRefChipIcon = kind
  chip.style.setProperty('--dsh-ref-chip-icon-mask', mask)
}

function clearChipIcon(chip: HTMLElement): void {
  delete chip.dataset.dshRefChipIcon
  chip.style.removeProperty('--dsh-ref-chip-icon-mask')
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function createProviderIcon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const shape = document.createElementNS(SVG_NS, 'path')
  shape.setAttribute('fill', 'currentColor')
  shape.setAttribute('fill-rule', 'evenodd')
  shape.setAttribute('d', path)
  svg.append(shape)
  return svg
}

function createPickerIcon(kind: PickerIconKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(PICKER_ICON_STROKE_WIDTH))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const node of PICKER_ICON_NODES[kind]) {
    const shape = document.createElementNS(SVG_NS, node.tag)
    for (const [name, value] of Object.entries(node.attrs)) shape.setAttribute(name, value)
    svg.append(shape)
  }
  return svg
}

function providerIconMask(path: string): string {
  return svgMask(`<path fill="black" fill-rule="evenodd" d="${path}"/>`)
}

function pickerIconMask(kind: PickerIconKind): string {
  const nodes = PICKER_ICON_NODES[kind].map(node => {
    const attrs = Object.entries(node.attrs).map(([name, value]) => `${name}="${value}"`).join(' ')
    return `<${node.tag} ${attrs}/>`
  }).join('')
  return svgMask(`<g fill="none" stroke="black" stroke-width="${String(PICKER_ICON_STROKE_WIDTH)}" stroke-linecap="round" stroke-linejoin="round">${nodes}</g>`)
}

function svgMask(content: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${content}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
