"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { DeviceOperationManager, DeviceOperationSnapshot } from "@/lib/devices/operations";
import type { DeviceArtifact } from "@/lib/devices/artifacts";
export interface FastbootCommandProps { manager:DeviceOperationManager; deviceId:string; label:string; interfaceNumber?:number; alternateSetting?:number; input?:DeviceArtifact }
const control:React.CSSProperties={minHeight:48,padding:8,border:"1px solid var(--border)",borderRadius:"var(--radius-control)",background:"var(--bg-panel)",color:"var(--text)"};
export function FastbootCommand({manager,deviceId,label,interfaceNumber,alternateSetting,input}:FastbootCommandProps) {
  const {t}=useI18n();const [command,setCommand]=useState("getvar all"),[operation,setOperation]=useState<DeviceOperationSnapshot>(),[error,setError]=useState("");
  useEffect(()=>manager.subscribe(snapshot=>{if(snapshot.id===operation?.id)setOperation(snapshot);}),[manager,operation?.id]);
  const active=operation&&!['succeeded','failed','cancelled'].includes(operation.state);
  const start=()=>{try{const result=manager.startUser({deviceId,protocol:"fastboot",action:"exec",command,interfaceNumber,alternateSetting,...(input?{fileId:input.id,sha256:input.sha256}:{})});setOperation(manager.status(result.id));setError("");}catch(caught){setError(String(caught));}};
  return <section aria-label={t("devices.fastbootTerminal",{device:label})} style={{display:"grid",minWidth:0,gap:8}}>
    <strong>{t("devices.fastbootTerminal",{device:label})}</strong>
    <form onSubmit={event=>{event.preventDefault();if(!active)start();}} style={{display:"flex",flexWrap:"wrap",gap:8}}>
      <label style={{flex:"1 1 180px",minWidth:0}}>{t("devices.operationCommand")}<input value={command} onChange={event=>setCommand(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} style={{...control,width:"100%",fontSize:16}}/></label>
      <button type="submit" className="ui-focus-ring" style={control} disabled={!!active}>{t("devices.terminalSend")}</button>
      {active&&<button type="button" className="ui-focus-ring" style={control} onClick={()=>manager.cancel(operation.id)}>{t("devices.cancelOperation")}</button>}
    </form>
    {input&&<small style={{overflowWrap:"anywhere"}}>{t("devices.operationSelectedInput")}: {input.name} — SHA-256 {input.sha256}</small>}
    {operation&&<pre aria-label={t("devices.operationOutput")} style={{margin:0,maxHeight:240,overflow:"auto",whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{operation.output.map(item=>item.line).join("\n")}
{operation.error||operation.result?.summary||operation.progress?.message}</pre>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
