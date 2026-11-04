/** Dependency-free check of the published schema's structural keyword subset. */
export function schemaValid(value:any,rule:any,schema:any):boolean{
  if(rule===true)return true;if(rule===false)return false;
  if(rule.$ref)return schemaValid(value,schema.$defs[rule.$ref.split('/').at(-1)],schema);
  if(rule.anyOf&&!rule.anyOf.some((x:any)=>schemaValid(value,x,schema)))return false;
  if(rule.oneOf&&rule.oneOf.filter((x:any)=>schemaValid(value,x,schema)).length!==1)return false;
  if('const'in rule&&JSON.stringify(value)!==JSON.stringify(rule.const))return false;
  if(rule.enum&&!rule.enum.includes(value))return false;
  if(rule.type&&!(rule.type==='null'?value===null:rule.type==='array'?Array.isArray(value):rule.type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):rule.type==='integer'?Number.isInteger(value):typeof value===rule.type))return false;
  if(typeof value==='string'&&((rule.minLength!==undefined&&value.length<rule.minLength)||(rule.maxLength!==undefined&&value.length>rule.maxLength)||(rule.pattern&&!new RegExp(rule.pattern).test(value))))return false;
  if(typeof value==='number'&&((rule.minimum!==undefined&&value<rule.minimum)||(rule.maximum!==undefined&&value>rule.maximum)||(rule.exclusiveMinimum!==undefined&&value<=rule.exclusiveMinimum)||(rule.exclusiveMaximum!==undefined&&value>=rule.exclusiveMaximum)))return false;
  if(Array.isArray(value)&&((rule.minItems!==undefined&&value.length<rule.minItems)||(rule.maxItems!==undefined&&value.length>rule.maxItems)||(rule.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)||(rule.items&&!value.every(x=>schemaValid(x,rule.items,schema)))))return false;
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    if((rule.required??[]).some((key:string)=>!Object.hasOwn(value,key)))return false;
    if((rule.minProperties!==undefined&&Object.keys(value).length<rule.minProperties)||(rule.maxProperties!==undefined&&Object.keys(value).length>rule.maxProperties))return false;
    for(const [key,field]of Object.entries(value))if(!schemaValid(field,rule.properties?.[key]??rule.additionalProperties??true,schema))return false;
  }return true;
}
