#!/usr/bin/env node
// Re-label a deterministic sample of recorded positions with Stockfish 19 Lite at a fixed node budget.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const [inputArg, outputArg, countArg='4000', nodesArg='100000'] = process.argv.slice(2);
if (!inputArg || !outputArg) throw new Error('Usage: node scripts/annotate-stockfish19-deep.mjs INPUT.gz OUTPUT.gz [SAMPLE_COUNT] [NODES]');
const input=resolve(inputArg), output=resolve(outputArg), count=Number(countArg), nodes=Number(nodesArg);
if (!Number.isInteger(count)||count<100||!Number.isInteger(nodes)||nodes<10000) throw new Error('Sample count >=100 and nodes >=10000 required.');
const raw=gunzipSync(readFileSync(input)).toString('utf8').split('\n').filter(Boolean);
const candidates=[];
for(const line of raw){const row=JSON.parse(line); if(row.teacherMove && row.legalMoves?.length && row.teacherScoreBound==='exact') candidates.push(row);}
if(candidates.length<count) throw new Error(`Only ${candidates.length} exact-score positions; cannot sample ${count}.`);
let seed=20261117; const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
for(let i=candidates.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[candidates[i],candidates[j]]=[candidates[j],candidates[i]];}
const selected=candidates.slice(0,count);
const temp=mkdtempSync(join(tmpdir(),'omega-sf19-'));
const sfJs=resolve('public/stockfish/stockfish-19-lite-single.js');
const sfWasm=resolve('public/stockfish/stockfish-19-lite-single.wasm');
const bin=join(temp,'stockfish19.cjs');
copyFileSync(sfJs,bin);copyFileSync(sfWasm,join(temp,'stockfish19.wasm'));
const proc=spawn(process.execPath,[bin],{stdio:['pipe','pipe','ignore']});
const rl=readline.createInterface({input:proc.stdout});
let waiters=[];let lastInfo='';let closed=false;
rl.on('line',line=>{if(line.startsWith('info '))lastInfo=line;for(let i=0;i<waiters.length;i++){if(waiters[i].test(line)){const w=waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(line);break;}}});
proc.on('exit',()=>{closed=true;for(const w of waiters){clearTimeout(w.timer);w.reject(new Error('Stockfish exited unexpectedly'));}waiters=[];});
function waitFor(test,timeout=30000){return new Promise((resolveWait,reject)=>{const w={test,resolve:resolveWait,reject,timer:setTimeout(()=>{waiters=waiters.filter(x=>x!==w);reject(new Error('Stockfish UCI timeout'));},timeout)};waiters.push(w);});}
function send(s){if(closed)throw new Error('Stockfish process is closed');proc.stdin.write(s+'\n');}
function parseInfo(line){const get=(re)=>line.match(re)?.[1];const cp=get(/\bscore cp (-?\d+)/);const mate=get(/\bscore mate (-?\d+)/);return {teacherDepth:Number(get(/\bdepth (\d+)/)||0),teacherNodes:Number(get(/\bnodes (\d+)/)||0),teacherScoreCp:cp===undefined?null:Number(cp),teacherScoreMate:mate===undefined?null:Number(mate),teacherScoreBound:/\b(?:upperbound|lowerbound)\b/.test(line)?'bound':'exact',teacherPv:(get(/\bpv (.+)$/)||'').split(/\s+/).filter(Boolean)};}
try{
 send('uci');await waitFor(x=>x==='uciok');send('setoption name Hash value 32');send('setoption name Threads value 1');send('isready');await waitFor(x=>x==='readyok');
 const outputRows=[];let skipped=0;const start=Date.now();
 for(let i=0;i<selected.length;i++){
  const row=selected[i];lastInfo='';send('ucinewgame');send(`position fen ${row.fen}`);send(`go nodes ${nodes}`);
  const bestLine=await waitFor(x=>x.startsWith('bestmove '),60000);const best=bestLine.split(/\s+/)[1];
  if(!best||best==='(none)'||!row.legalMoves.includes(best)){skipped++;continue;}
  const info=parseInfo(lastInfo);if(info.teacherScoreCp===null&&info.teacherScoreMate===null){skipped++;continue;}
  outputRows.push({...row,teacherMove:best,...info,teacherNodeBudget:nodes,teacherScorePerspective:'side-to-move',teacherSource:'Stockfish 19 Lite WASM',teacherSourceSha256:createHash('sha256').update(readFileSync(sfJs)).digest('hex')});
  if((i+1)%100===0)console.log(JSON.stringify({processed:i+1,kept:outputRows.length,skipped,elapsedSeconds:Math.round((Date.now()-start)/1000)}));
 }
 mkdirSync(join(output,'..'),{recursive:true});
 const payload=outputRows.map(x=>JSON.stringify(x)).join('\n')+'\n';writeFileSync(output,gzipSync(payload,{level:9}));
 const report={status:'complete',input,output,sampled:candidates.length,requested:count,kept:outputRows.length,skipped,nodesPerPosition:nodes,stockfish:'Stockfish 19 Lite WASM',sourceSha256:createHash('sha256').update(readFileSync(sfJs)).digest('hex'),dataSha256:createHash('sha256').update(payload).digest('hex'),elapsedSeconds:Math.round((Date.now()-start)/1000),openingFamilies:[...new Set(outputRows.map(x=>x.openingFamily))].sort()};
 writeFileSync(output.replace(/\.gz$/,'')+'.report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {try{send('quit');}catch{};proc.kill();rmSync(temp,{recursive:true,force:true});}
