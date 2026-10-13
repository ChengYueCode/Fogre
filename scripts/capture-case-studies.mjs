#!/usr/bin/env node
// Optional maintainer capture tool: Playwright, local Chrome, editor network access.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const modulePath=process.env.FORGE_PLAYWRIGHT_MODULE;
const {chromium}=await import(modulePath?pathToFileURL(modulePath).href:'playwright');
const browser=await chromium.launch({headless:true,channel:'chrome'});
const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
const assets=path.join(root,'docs/assets/cases');await fs.mkdir(assets,{recursive:true});const records=[];
const base='examples/mattpocock-skills/';const digest=data=>createHash('sha256').update(data).digest('hex');
const open=async file=>page.goto(pathToFileURL(path.join(root,base,file)).href);
async function shot(name,locator,source,action){await page.evaluate(()=>document.fonts.ready);const file=path.join(assets,`${name}.png`);if(locator)await locator.screenshot({path:file});else await page.screenshot({path:file});records.push({image:`docs/assets/cases/${name}.png`,source:base+source,viewport:page.viewportSize(),action,sourceSha256:digest(await fs.readFile(path.join(root,base,source))),imageSha256:digest(await fs.readFile(file))})}
try{
 await open('index.html');await shot('mp-hub',null,'index.html','实际打开新主题资料总入口，27 正式、11 附录、8 单元与未知学习状态。');
 await page.getByLabel('搜索技能或场景').fill('to-spec');await page.locator('#skill-to-spec summary').click();await shot('mp-catalog',page.locator('#catalog'),'index.html','实际搜索并展开 to-spec，查看必要输入、自带流程与边界。');
 await page.getByLabel('搜索技能或场景').fill('');if(await page.locator('.skill:visible').count()!==38)throw new Error('Catalog reset did not restore all 38 skills');
 await shot('mp-sources',page.locator('#sources'),'index.html','固定提交、107 文件的来源清单与未验证范围。');
 await open('overview/index.html');await page.locator('#nodeLayer').getByRole('button',{name:/^谁能发起调用/}).click();await shot('mp-invocation',page.locator('#interaction-invocation-compare'),'overview/index.html','实际选择调用身份并查看用户入口与模型入口对照。');
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.getByRole('button',{name:'折叠到一级',exact:true}).click();
 const foundation=page.locator('#nodeLayer [data-id="foundation"]');await foundation.click();
 await page.getByRole('button',{name:'聚焦选中',exact:true}).click();await foundation.locator('[data-collapse]').click();
 const stage=await page.locator('#graphStage').boundingBox();const node=await foundation.boundingBox();
 const center={x:stage.x+stage.width/2,y:stage.y+stage.height/2};
 await page.mouse.move(stage.x+stage.width/2,stage.y+stage.height-35);await page.mouse.down();
 await page.mouse.move(stage.x+stage.width/2+center.x-node.x-node.width/2,stage.y+stage.height-35+center.y-node.y-node.height/2,{steps:8});await page.mouse.up();
 await page.mouse.move(center.x,center.y);
 const scale=()=>page.locator('#graphCanvas').evaluate(element=>new DOMMatrix(getComputedStyle(element).transform).a);
 while(await scale()<0.7){const before=await scale();await page.mouse.wheel(0,-100);await page.waitForFunction(previous=>new DOMMatrix(getComputedStyle(document.querySelector('#graphCanvas')).transform).a>previous,before);}
 await shot('mp-overview',null,'overview/index.html','atlas 实际聚焦入口与调用分组，展开子节点并缩放查看；其余入口可从全景和目录探索。');
 await open('workflow/index.html');await shot('mp-workflow',null,'workflow/index.html','sequence 工程路线与分步推演。');
 await shot('mp-workflow-start',page.locator('#interaction-engineering-trace'),'workflow/index.html','第 1 步：先澄清目标和语言。');
 for(let i=0;i<4;i++)await page.getByRole('button',{name:'下一步',exact:true}).click();
 await shot('mp-workflow-end',page.locator('#interaction-engineering-trace'),'workflow/index.html','实际推进至第 5 步：需求和规范分开审查。');
 await page.reload();if(!(await page.locator('#interaction-engineering-trace').innerText()).includes('步骤 5/5'))throw new Error('Workflow observation position did not survive reload');
 await open('comparisons/index.html');await page.locator('#nodeLayer').getByRole('button',{name:/^综合规格与拆解任务/}).click();await shot('mp-comparison',page.locator('#interaction-compare-2'),'comparisons/index.html','实际选择 to-spec 与 to-tickets，比较场景、输入、产物和用户确认。');
 await page.locator('#interaction-compare-2').getByRole('button',{name:'进入本题',exact:true}).click();
 const reference='已有讨论变成规格，或可用规格变成可验收任务图。';if((await page.locator('#panel').innerText()).includes(reference))throw new Error('Reference visible before a learner explicitly reveals it');
 await shot('mp-practice',page.locator('#panel'),'comparisons/index.html','实际进入比较题；未填入模拟作答，参考初始隐藏。');
 await open('tool-demo/index.html');for(const id of ['review','resume','plan','insights'])await shot(`mp-${id}`,page.locator(`#${id}`),'tool-demo/index.html',`新主题的实际 CLI ${id} 读回；合成输入明确标注。`);
 await open('question/index.html');await shot('mp-question',page.locator('main'),'question/index.html','围绕 mattpocock/skills 调用身份的当前单次实际响应；不验证安装发现。');
 await open('quick-reference.html');await shot('mp-quick-reference',null,'quick-reference.html','同一主题的可打印场景速查与固定版本链接。');
 for(const name of ['overview','workflow','comparisons']){
  const source=`${name}/map.svg`;const svg=await fs.readFile(path.join(root,base,source),'utf8');
  const dimensions=svg.match(/<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/);
  if(!dimensions)throw new Error(`SVG dimensions missing: ${source}`);
  await page.setViewportSize({width:Number(dimensions[1]),height:Number(dimensions[2])});
  await open(source);await shot(`mp-map-${name}`,null,source,'按最终 SVG 原始尺寸实际打开并截图；没有重排、删减节点或加入新内容。');
 }
 await page.setViewportSize({width:1440,height:1000});
 const editor=await context.newPage();await editor.setViewportSize({width:2400,height:1100});editor.on('pageerror',error=>errors.push(error.message));
 await editor.addInitScript(()=>{delete window.showOpenFilePicker;delete window.showSaveFilePicker});
 await editor.goto('https://excalidraw.com',{waitUntil:'networkidle',timeout:45000});const chooser=editor.waitForEvent('filechooser');await editor.getByRole('button',{name:/^打开|^Open/}).click();await(await chooser).setFiles(path.join(root,base,'workflow/map.excalidraw'));await editor.getByRole('button',{name:/^打开|^Open/}).waitFor({state:'hidden'});await editor.keyboard.press('Shift+Digit1');await editor.keyboard.press('Control+a');await editor.evaluate(()=>document.fonts.ready);await editor.screenshot({path:path.join(assets,'mp-editor.png')});
 records.push({image:'docs/assets/cases/mp-editor.png',source:base+'workflow/map.excalidraw',viewport:{width:2400,height:1100},action:'在独立 Excalidraw 编辑器实际加载新主题工程路线原生导图并选中元素。',sourceSha256:digest(await fs.readFile(path.join(root,base,'workflow/map.excalidraw'))),imageSha256:digest(await fs.readFile(path.join(assets,'mp-editor.png')))});await editor.close();
 if(errors.length)throw new Error('Browser errors: '+errors.join('; '));
 await open('index.html');await page.screenshot({path:path.join(root,'docs/assets/forge-preview.jpg'),type:'jpeg',quality:88});
 await fs.writeFile(path.join(assets,'manifest.json'),JSON.stringify({kind:'actual-browser-captures',topic:'学习 mattpocock/skills',upstreamCommit:'49dd158d1076134a641b33efb035946536778336',generatedAt:new Date().toISOString(),viewport:{width:1440,height:1000},browser:browser.version(),disclosure:'新主题作者学习产物、明确标注的合成工具读回以及当前实际单次响应；不证明真人掌握或宿主安装发现。',records},null,2)+'\n');
 console.log(JSON.stringify({screenshots:records.length,browserErrors:errors.length,catalogAndReloadAndHiddenReferenceChecks:'passed'}));
}finally{await browser.close()}
