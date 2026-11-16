import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('concurrent observation requires actual readiness, one MTA input and its successful return', { skip: process.platform !== 'win32', timeout: 30000 }, () => {
  const script = readFileSync(new URL('../scripts/verify-native-uia.ps1', import.meta.url), 'utf8');
  const helper = script.split('// BEGIN ISOLATED CONCURRENT OBSERVATION')[1]?.split('// END ISOLATED CONCURRENT OBSERVATION')[0];
  assert(helper, 'Exercise the exact helper compiled into the native driver.');
  const checks = String.raw`
public static class ConcurrentObservationChecks {
  static void Check(bool result,string message){if(!result)throw new Exception(message);}
  static void Reject(Action action,string fragment){try{action();}catch(Exception error){Check(error.ToString().Contains(fragment),"Unexpected rejection: "+error);return;}throw new Exception("Expected rejection: "+fragment);}
  public static string Run(){
    int calls=0;
    Reject(()=>NativeConcurrentObservation.Run(()=>calls++,()=>true,()=>{},()=>{},100),"already ready before input");Check(calls==0,"Pre-existing readiness sent an input.");
    int ready=0,painted=0;ApartmentState apartment=ApartmentState.Unknown;
    NativeConcurrentObservation immediate=NativeConcurrentObservation.Run(()=>{Interlocked.Increment(ref calls);apartment=Thread.CurrentThread.GetApartmentState();Volatile.Write(ref ready,1);},()=>Volatile.Read(ref ready)==1,()=>painted++,()=>{},1000);
    Check(calls==1&&painted==1&&apartment==ApartmentState.MTA,"Input was duplicated, non-MTA or not painted.");Check(immediate.InputStartedMs>=0&&immediate.UiReadyMs>=immediate.InputStartedMs&&immediate.InputCallReturnedMs>=0&&immediate.InputReturnedAfterReadyMs>=0,"Negative timing or readiness before input started.");Check(immediate.UiReadyAtUtcMs>=immediate.StartedAtUtcMs,"Readiness wall-clock precedes input start.");
    using(ManualResetEventSlim allowReturn=new ManualResetEventSlim(false)){
      int completed=0;ready=0;calls=0;
      NativeConcurrentObservation delayed=NativeConcurrentObservation.Run(()=>{Interlocked.Increment(ref calls);Volatile.Write(ref ready,1);allowReturn.Wait();Thread.Sleep(200);Volatile.Write(ref completed,1);},()=>Volatile.Read(ref ready)==1,()=>{Check(Volatile.Read(ref completed)==0,"Input completed before the readiness observation.");allowReturn.Set();},()=>{},2000);
      Check(calls==1&&completed==1,"The sample returned before successful input completion.");Check(delayed.UiReadyMs<delayed.InputCallReturnedMs&&delayed.InputReturnedAfterReadyMs>0,"Readiness and delayed input return were not distinguished.");
    }
    using(ManualResetEventSlim allowFailure=new ManualResetEventSlim(false)){
      ready=0;int next=0;
      Reject(()=>{NativeConcurrentObservation.Run(()=>{Volatile.Write(ref ready,1);allowFailure.Wait();throw new Exception("delayed input failure");},()=>Volatile.Read(ref ready)==1,()=>allowFailure.Set(),()=>{},1000);next++;},"delayed input failure");Check(next==0,"A successful-looking UI result hid an input failure.");
    }
    using(ManualResetEventSlim unblock=new ManualResetEventSlim(false))using(ManualResetEventSlim returned=new ManualResetEventSlim(false)){
      ready=0;int next=0;bool pending=false;
      try{try{NativeConcurrentObservation.Run(()=>{Volatile.Write(ref ready,1);unblock.Wait();returned.Set();},()=>Volatile.Read(ref ready)==1,()=>{},()=>{},100);next++;}catch(NativeInputPendingException){pending=true;}}
      finally{unblock.Set();Check(returned.Wait(2000),"Synthetic pending input did not finish after release.");}
      Check(pending&&next==0,"Pending input was promoted to success or a subsequent operation.");
    }
    Reject(()=>NativeConcurrentObservation.Run(()=>{},()=>false,()=>{},()=>{},50),"not presented before the observation deadline");
    ready=0;int observations=0;
    Reject(()=>NativeConcurrentObservation.Run(()=>Volatile.Write(ref ready,1),()=>{if(Interlocked.Increment(ref observations)>1)Thread.Sleep(100);return Volatile.Read(ref ready)==1;},()=>{},()=>{},50),"absolute deadline");
    ready=0;Reject(()=>NativeConcurrentObservation.Run(()=>Volatile.Write(ref ready,1),()=>Volatile.Read(ref ready)==1,()=>Thread.Sleep(100),()=>{},50),"absolute deadline");
    ready=0;bool paintedOnce=false;
    Reject(()=>NativeConcurrentObservation.Run(()=>Volatile.Write(ref ready,1),()=>{if(paintedOnce)Thread.Sleep(100);return Volatile.Read(ref ready)==1;},()=>paintedOnce=true,()=>{},50),"absolute deadline");
    ready=0;int confirmations=0;
    Reject(()=>NativeConcurrentObservation.Run(()=>Volatile.Write(ref ready,1),()=>{if(Volatile.Read(ref ready)==1&&Interlocked.Increment(ref confirmations)>=3)Thread.Sleep(100);return Volatile.Read(ref ready)==1;},()=>{},()=>{},50),"Final native UI confirmation exceeded its absolute deadline");
    calls=0;Reject(()=>NativeConcurrentObservation.Run(()=>calls++,()=>false,()=>{},()=>{throw new Exception("identity rejected");},100),"identity rejected");Check(calls==0,"Identity failure sent an input.");
    return "precondition,once,mta,paint,early-readiness,await-return,error-after-ready,pending-input,missing-result,identity";
  }
}`;
  const source = Buffer.from('using System;\nusing System.Diagnostics;\nusing System.Threading;\n' + helper + checks).toString('base64');
  const temporary = 'D:\\03_github_projects\\Agent_Management\\Agent_Resource_Manager\\validation\\manager-data\\concurrent-observation-unit';
  mkdirSync(temporary, { recursive: true });
  const command = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))); [ConcurrentObservationChecks]::Run()`;
  const result = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TEMP: temporary, TMP: temporary }, windowsHide: true, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.trim(), 'precondition,once,mta,paint,early-readiness,await-return,error-after-ready,pending-input,missing-result,identity');
});
