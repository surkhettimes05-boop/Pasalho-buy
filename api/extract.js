export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'POST required'});}
  const key=process.env.OPENAI_API_KEY;
  const access=process.env.EXTRACT_ACCESS_CODE;
  if(!key||!access)return res.status(503).json({error:'Extraction not configured. Add OPENAI_API_KEY and EXTRACT_ACCESS_CODE in Vercel environment settings.'});
  if(req.headers['x-extract-code']!==access)return res.status(401).json({error:'Incorrect extraction access code.'});
  try{
    const {data,mime,name}=req.body||{};
    const allowed=['image/jpeg','image/png','image/webp','application/pdf'];
    if(!allowed.includes(mime)||typeof data!=='string'||!/^[-A-Za-z0-9+/]*={0,2}$/.test(data))return res.status(400).json({error:'Use a JPEG, PNG, WebP or PDF.'});
    if(data.length>5_600_000)return res.status(413).json({error:'File too large. Use a file under 4 MB.'});
    const bytes=Buffer.from(data,'base64');if(!bytes.length||bytes.length>4*1024*1024)return res.status(413).json({error:'File must be under 4 MB.'});
    const isPdf=mime==='application/pdf';
    const content=isPdf?{type:'input_file',filename:String(name||'quotation.pdf').replace(/[^a-zA-Z0-9_.-]/g,'_'),file_data:'data:'+mime+';base64,'+data}:{type:'input_image',image_url:'data:'+mime+';base64,'+data,detail:'high'};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55000);
    let response;
    try{response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.EXTRACT_MODEL||'gpt-4.1-mini',store:false,max_output_tokens:6500,input:[{role:'system',content:[{type:'input_text',text:'Extract line items from a Nepal FMCG supplier quotation image or PDF. Return ONLY valid JSON object {"rows":[{"name":"","unit":"","casePack":"","mrp":"","cartonCost":"","moq":"","free":"","rebate":"","freight":"","weeklyDemand":""}],"warnings":[]}. Values should be plain numeric strings or empty strings. Never invent values; leave missing fields empty. Keep exact price and unit basis; cartonCost must ONLY be filled if clearly per-carton, not per-piece. MRP must ONLY be filled if per selling unit. If unit basis is unclear, leave the relevant value empty and add a warning. Default nothing (not even MOQ). No assumed demand. Return at most 100 product rows. Preserve product names. Distinguish free units from free cartons; if unclear leave free blank. Do not copy supplier contact details.'}]},{role:'user',content:[{type:'input_text',text:'Extract quotation lines and missing-field warnings.'},content]}]}) ,signal:controller.signal});}finally{clearTimeout(timer)}
    const json=await response.json().catch(()=>({}));
    if(!response.ok)return res.status(502).json({error:'Extraction provider error: '+(json.error?.message||response.status)});
    const out=(json.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n').trim();
    let parsed;try{parsed=JSON.parse(out)}catch{const match=out.match(/\{[\s\S]*\}/);if(!match)throw Error('Could not parse extracted quotation.');parsed=JSON.parse(match[0])}
    if(!Array.isArray(parsed.rows))throw Error('No product table found.');
    const keys=['name','unit','casePack','mrp','cartonCost','moq','free','rebate','freight','weeklyDemand'];
    const rows=parsed.rows.slice(0,100).map(r=>Object.fromEntries(keys.map(k=>[k,typeof r?.[k]==='string'?r[k]:r?.[k]==null?'':String(r[k])])));
    return res.status(200).json({rows,warnings:Array.isArray(parsed.warnings)?parsed.warnings.slice(0,20).map(String):[],reviewRequired:true});
  }catch(e){return res.status(502).json({error:e.name==='AbortError'?'Extraction timed out. Try a smaller image.':e.message||'Extraction failed.'})}
}