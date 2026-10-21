const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const sha = (b) => createHash("sha256").update(b).digest("hex");

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 64,
      height: 48,
      webPreferences: { backgroundThrottling: false },
    });
    await window.loadURL("data:text/html,<html></html>");
    const result = await window.webContents.executeJavaScript(`(() => {
    const width=64,height=48;
    const coverage=[]; const stroke=[]; const color=[];
    for(let y=0;y<16;y++) for(let x=0;x<16;x++) {
      const inside=(x>=2&&x<=4&&y>=2&&y<=13)||(x>=11&&x<=13&&y>=2&&y<=13)||(y>=6&&y<=8&&x>=2&&x<=13);
      coverage.push(inside ? (x===2||x===13 ? 85 : 255) : 0);
      stroke.push(x>=1&&x<=14&&y>=1&&y<=14&&(x<=2||x>=13||y<=2||y>=13) ? 255 : 0);
    }
    for(let y=0;y<8;y++) for(let x=0;x<8;x++) {
      const a=[85,170,255][(x+y)%3]; color.push(x<4?a:0,y<4?a:0,x>=4?a:0,a);
    }
    const glyphs=[{width:16,height:16,format:'coverage',data:coverage},{width:16,height:16,format:'coverage',data:stroke},{width:8,height:8,format:'premultiplied_srgb_rgba',data:color},{width:0,height:0,format:'coverage',data:[]}];
    const draw=(placement,baseline,color,transform=[1,0,0,1,0,0],clip=[0,0,width,height])=>({placement,baseline,color,transform,clip});
    const cases=[
      {id:'fill',draws:[draw(0,[5,5],[1,0,0,1]),draw(0,[25,5],[0,0,1,0.5])]},
      {id:'overlap',draws:[draw(0,[5,5],[1,0,0,1]),draw(0,[10,9],[0,0,1,0.5])]},
      {id:'transforms',draws:[draw(0,[0,0],[1,0,1,1],[0,1,-1,0,35,5]),draw(0,[0,0],[0,1,0,1],[-2,0,0,-2,50,40],[10,5,35,30]),draw(3,[0,0],[1,1,1,1])]},
      {id:'stroke',draws:[draw(1,[5,5],[0,1,0,1]),draw(0,[5,5],[1,1,1,1])]},
      {id:'color',draws:[draw(2,[0,0],[1,1,1,1],[2,0,0,2,5,5]),draw(2,[28,8],[1,1,1,0.5])]},
      {id:'fractional',draws:[draw(0,[5,5],[1,1,1,1],[1,0,0,1,0.25,0.5])]},
    ];
    const references=cases.map(item=>{
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');
      for(const draw of item.draws){
        const glyph=glyphs[draw.placement]; if(!glyph.width)continue;
        const source=document.createElement('canvas');source.width=glyph.width;source.height=glyph.height;
        const sourceCtx=source.getContext('2d');const image=sourceCtx.createImageData(glyph.width,glyph.height);
        for(let i=0;i<glyph.width*glyph.height;i++){
          const alpha=glyph.format==='coverage'?glyph.data[i]:glyph.data[i*4+3];
          const rgb=glyph.format==='coverage'?draw.color.slice(0,3).map(v=>Math.round(v*255)):glyph.data.slice(i*4,i*4+3).map(v=>alpha?Math.round(v*255/alpha):0);
          image.data.set([...rgb,alpha],i*4);
        }
        sourceCtx.putImageData(image,0,0);
        ctx.save();ctx.beginPath();ctx.rect(...draw.clip);ctx.clip();ctx.transform(...draw.transform);ctx.globalAlpha=draw.color[3];ctx.drawImage(source,...draw.baseline);ctx.restore();
      }
      return {id:item.id,pixels:Array.from(ctx.getImageData(0,0,width,height).data)};
    });
    const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,1,1);ctx.fillStyle='rgba(0,0,255,0.5)';ctx.fillRect(0,0,1,1);
    return {fixture:{width,height,glyphs,cases},references,color_probe:Array.from(ctx.getImageData(0,0,1,1).data),context:ctx.getContextAttributes()};
  })()`);
    const directory = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
    fs.mkdirSync(directory, { recursive: true });
    const publish = (name, data) => {
      const target = path.join(directory, name);
      if (fs.existsSync(target)) throw new Error(`Existing reference ${name}`);
      const temp = target + ".tmp";
      fs.writeFileSync(temp, data, { flag: "wx" });
      fs.renameSync(temp, target);
    };
    const fixture = Buffer.from(JSON.stringify(result.fixture, null, 2) + "\n");
    publish("fixture.data", fixture);
    const cases = result.references.map((item) => {
      const bytes = Buffer.from(item.pixels);
      const name = item.id + ".rgba";
      publish(name, bytes);
      return { id: item.id, path: name, sha256: sha(bytes) };
    });
    publish(
      "manifest.json",
      JSON.stringify(
        {
          version: 1,
          producer: "Electron Canvas2D",
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          capture_sha256: sha(fs.readFileSync(__filename)),
          fixture_sha256: sha(fixture),
          color_probe: result.color_probe,
          context: result.context,
          cases,
        },
        null,
        2,
      ) + "\n",
    );
    window.close();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
