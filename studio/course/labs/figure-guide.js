import {el} from "../course.js";

// Bounds are percentages of the original, unmodified paper crop, left/top/width/height.
const guides={
  "qubic-hardware":[
    ["Convert a number",14,39,12,16,"Find DAC on the left. It supplies an analog waveform to the outgoing electronics. Follow a green line toward the chip."],
    ["Drive the chip",70,36,28,27,"Several green drive paths reach the processor at right. The orange probe and return take a separate route."],
    ["Bring a signal back",46,41,19,14,"Follow the returning orange line left to DN. The downconverter translates the response for sampling by the ADC."]],
  "qubic-logic":[
    ["Choose a command",15,34,57,13,"The command names a destination, a trigger time and where the stored envelope begins. Follow the red control arrows upward."],
    ["Make a drive",2,4,49,24,"The upper buffer supplies an envelope. Frequency and phase guide digital upconversion. The result goes right toward the DAC."],
    ["Read the response",16,52,68,26,"Start at the ADC on the right. Follow the arrow left into downconversion, then down toward accumulation."]],
  "duke-step":[
    ["Find the starting rail",11,38,39,6,"Read the flat region on the upper trace against the vertical axis. It starts near −10 V."],
    ["Locate the crossing",52,15,9,21,"Follow the upper trace to zero volts. Its slope tells you how fast the connector voltage is changing there."],
    ["Compare the reverse step",47,54,19,36,"The lower trace falls from the positive rail. Compare the central slope and the time taken to approach the final rail."]],
  "atom-transport":[
    ["Locate the carriers",1,61,25,35,"Panel b starts with close pairs. Identify a pair by the two spots aligned in the first image."],
    ["Read the separation",26,61,25,35,"The second image shows the separated rows. Use the 110 µm marker on the right to read their spacing."],
    ["Test the state",53,61,23,35,"In panel c, compare the stationary and transported points at the same analysis phase. Atom positions alone cannot give this information."]],
  "ion-trap":[
    ["Find the ion",57,2,41,25,"Panel c shows the ion as a single orange dot. Read the 70 µm vertical dimension from the electrode surface."],
    ["Read the conveyor",31,2,24,25,"Panel b enlarges a curved section. Read the repeating electrode labels along the path to see which positions share a pattern."],
    ["Locate a gate zone",29,59,9,8,"Panel d marks a pair at a crossing of laser paths. Follow the rail to see how ions reach that zone."]],
  "qubic-benchmark":[
    ["Read one length",46,20,5,17,"The vertical group near length 512 contains many random circuits of the same length. The spread is visible even at a fixed length."],
    ["Follow the fitted decay",48,26,34,10,"The upper curve estimates the trend across lengths for the single-qubit experiment. Its fitted parameter appears in the legend."],
    ["Compare the axes",19,84,69,12,"Check the horizontal scale of the lower plot before comparing curves. The two-qubit sequences use a much shorter range of lengths."]]
};

export function guideFigures(article) {
  const comparisons={
    S1:{"qubic-hardware":["dac","Compare the outgoing converter in the lab"],"duke-step":["scope","Compare the ideal probe with this measured step"]},
    S2:{"qubic-logic":["phase","Inspect the lab’s phase register"]},S3:{"qubic-logic":["product","Inspect the lab’s digital mixer output"]},
    R1:{"qubic-hardware":["adc","Inspect a return sample in the lab"]},
    P2:{"atom-transport":["atom1","Find the upper atom in the transport replay"]},
    M2:{"atom-transport":["aod","Compare the commanded separation with panel b"]}
  };
  for(const figure of article.querySelectorAll("figure.paper-figure")){
    const anchor=figure.querySelector("a:has(img)"), image=anchor?.querySelector("img");
    if(!image)continue;
    const key=image.src.split("/").pop().replace(".png","");
    const guide=guides[key];if(!guide)continue;
    const wrap=el("div",{class:"guided-figure-image"});
    anchor.replaceWith(wrap);wrap.append(anchor);
    const mark=el("span",{class:"figure-highlight",hidden:"","aria-hidden":"true"});wrap.append(mark);
    const explanation=el("p",{class:"figure-explanation","aria-live":"polite",text:"Choose a feature to locate it in the paper figure."});
    const controls=el("div",{class:"figure-controls","aria-label":"Read the published figure"});
    for(const [name,x,y,w,h,note] of guide){
      const action=el("button",{type:"button",text:name,"aria-pressed":"false",onclick:()=>{
        for(const b of controls.children)b.setAttribute("aria-pressed",String(b===action));
        Object.assign(mark.style,{left:x+"%",top:y+"%",width:w+"%",height:h+"%"});mark.hidden=false;
        explanation.textContent=note;
      }});
      controls.append(action);
    }
    figure.append(controls,explanation);
    const comparison=comparisons[document.body.dataset.lesson]?.[key];
    if(comparison){
      const [part,label]=comparison;
      figure.append(el("a",{href:"#workshop",text:label,onclick:()=>{
        document.querySelector("#workshop")?.dispatchEvent(new CustomEvent("figure-probe",{detail:part}));
      }}));
    }
  }
}
