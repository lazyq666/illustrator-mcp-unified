import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { bounds, backingSchema, cardSchema } from '../../src/cards/schema.js';
it('exposes the four card tools using homogeneous arrays in the actual MCP tools/list response',async()=>{
  const server=createServer(),client=new Client({name:'schema-test',version:'1'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);await client.connect(clientTransport);
    const result=await client.listTools();
    for(const name of ['import_pdf_as_paths','build_name_backing','batch_cards','validate_cards']){
      const tool=result.tools.find(t=>t.name===name);expect(tool,name).toBeDefined();
      expect(JSON.stringify(tool!.inputSchema),name).not.toContain('"prefixItems"');
      function check(value:any):void {
        if(!value || typeof value!=='object')return;
        if(value.type==='array'){expect(value.items,name).toBeTypeOf('object');expect(Array.isArray(value.items),name).toBe(false);}
        for(const child of Object.values(value))check(child);
      }
      check(tool!.inputSchema);
    }
  } finally {await client.close();await server.close();}
});
it('retains exact lengths, value limits and bounds ordering',()=>{
  expect(bounds.safeParse([0,100,60,0]).success).toBe(true);
  for(const v of [[0,100,60],[0,100,60,0,1],[60,100,0,0],[0,0,60,100]])expect(bounds.safeParse(v).success).toBe(false);
  for(const rgb of [[0,255],[0,255,0,0],[0,256,0]])expect(backingSchema.safeParse({offset_pt:1,stops:[{position:0,rgb},{position:100,rgb}]}).success).toBe(false);
  expect(cardSchema.safeParse({id:'a',name:'a',aligned_image_pairs:[['a','b','c']]}).success).toBe(false);
});
