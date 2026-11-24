// node studio/course/labs/run.mjs manila [program.json]
import {readFile} from "node:fs/promises";
import {programs, replay} from "./replay.mjs";
import {activities,executeActivity,settingsFor} from "./activities.mjs";
import {isDeepStrictEqual} from "node:util";
const [name, file] = process.argv.slice(2);
const json = async path => JSON.parse(await readFile(path,"utf8"));
try {
  if(name==="experiment" || Object.hasOwn(activities,name)){
    const saved=file ? await json(file) : null;
    const id=name==="experiment" ? saved?.lesson : name;
    if(!Object.hasOwn(activities,id) || (saved && saved.lesson!==id))throw Error("Choose a valid lesson experiment.");
    const settings=settingsFor(id,new URLSearchParams(saved?.settings));
    const request=async(path,body)=>{
      const response=await fetch(new URL(path,process.env.QCONTROL_URL??"http://127.0.0.1:7432"),
        body ? {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)} : {});
      if(!response.ok)throw Error(await response.text());
      return response.json();
    };
    const {run,program,evaluation}=await executeActivity(id,settings,{json,request});
    const executable=run.document??program;
    if(saved && (!isDeepStrictEqual(settings,saved.settings)||!isDeepStrictEqual(executable,saved.program)))
      throw Error("Saved experiment differs from the current executable build.");
    console.log(JSON.stringify({lesson:id,settings,program:executable,evaluation,...run},null,2));
  }else{
    const program = file ? await json(file) : programs[name];
    console.log(JSON.stringify({program,...await replay(name,program,json)},null,2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
