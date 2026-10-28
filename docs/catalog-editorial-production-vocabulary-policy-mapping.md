# Total production policy/provisioning mapping — proposal v0.1 (wire v0.5)

**DRAFT pending joint BE/FE acceptance; S1–S8; no implementation/DB authorization.** Normative proposed companion to [wire](catalog-editorial-production-vocabulary-contract-proposal.md) and [facts](catalog-editorial-production-vocabulary-facts-contract.md).
Precedence: S7/S8 and current C3.2 > this integrated mapping of the normalized proposal > immutable snapshot. Original imports/hashes remain unchanged (wire §8). Source D16 cannot override current Published conservation.
E means ONLY the existing currently offered real-sellable eligibility result under existing coordination. No new all-real/current-care eligibility definition. Shape/reference checks cover all captured rows; publication rules/evidence/care gates consume E only.

## 1. Closed dispatch/data expansion

The JSON below is the TOTAL manifest mapping, not examples. ALL/DIM/EQUIP/COVER expand to the exact family lists in the checker; comma-separated family:rule entries expand to disjoint triples. Every bound (family,definition) gets exactly one fact_rule, parameter=that definition code, family=that family.
`ProductionDefinitionCode` is the closed union of the 68 expanded definition codes below; `OptionalDefinitionCode` at a family is exactly its parameters whose ruleId=optional. Neither type is unrestricted string. No required or optional production route is pending/option_cases.
All bindings: owner=sellable, searchable=false, exposure as immutable choice rows or numeric/other table. All seven families minimumContractVersion=2. RuleId is the closed 12-member wire union; `semanticsVersion:'editorial-production-1'` in VocabularyV2 covers dispatch, evidence, fact/care/NA consumption and numeric semantics. Any such semantics change requires a version bump in strict DTO/R, not only code changes.
publicationCheck=always for required/animal/form/fit/capacity/space/presentation, dimensions at toy, equipment at habitat, content at food/treat/hygiene/care; otherwise when_asserted. All production known-value evidenceRequired=true: normalized manufacturer-backed declarations/content/relevance and S4/S5 supported text/claims, including false/empty assertions. Optional omission/unknown never requires evidence. Title/description are not these typed assignments.
Numeric rows are [codes,type,units,families,exposure,domain,routes]; N=number, R=range, P=>0 real, I=positive integer, F=finite unbounded real. numericPolicy is resolved: magnitude=code, integer=(I), lower=0 only P/I else null, lowerInclusive=false, upper=null/upperInclusive=false. Range domain applies to both endpoints, plus inclusive min<=max. No null production units or conversions.
Other rows are [code,type,families,exposure]; T=text, B=boolean; they all use optional route. Choice definitions/types/groups/options/bindings come exactly from normalized §3, with routes explicitly enumerated below. No source.reference/source.checked_at attributes; facts/per-value evidence carry that meaning.

```json
{
 "semanticsVersion":"editorial-production-1",
 "choices":[
 ["animal.target","food:required,treat:required,toy:required,hygiene:animal,accessory:optional,habitat:optional,care:optional"],
 ["life.stage","ALL:optional"],
 ["pack.form","food:optional,treat:optional,toy:optional,hygiene:optional,accessory:optional,habitat:optional,care:presentation"],
 ["pack.sale","ALL:optional"],
 ["content.kind","ALL:optional"],
 ["material","toy:optional,hygiene:optional,accessory:optional,habitat:optional"],
 ["color.base","toy:optional,accessory:optional,habitat:optional"],
 ["size.label","toy:optional,accessory:optional"],
 ["size.animal","food:optional,treat:optional,toy:optional,accessory:optional"],
 ["food.format","food:required"],
 ["food.role","food:optional"],
 ["food.process","food:optional,treat:optional"],
 ["food.texture","food:optional,treat:optional"],
 ["food.aquatic","food:optional"],
 ["treat.form","treat:required"],
 ["treat.base","treat:optional"],
 ["toy.type","toy:required"],
 ["toy.feature","toy:optional"],
 ["hygiene.type","hygiene:required"],
 ["hygiene.form","hygiene:form"],
 ["hygiene.litter","hygiene:optional"],
 ["hygiene.scent","hygiene:optional"],
 ["accessory.type","accessory:required"],
 ["accessory.closure","accessory:optional"],
 ["accessory.feature","accessory:optional"],
 ["habitat.type","habitat:required"],
 ["habitat.environment","habitat:optional"],
 ["habitat.substrate","habitat:optional"],
 ["habitat.component","habitat:optional"],
 ["care.type","care:required"],
 ["care.form","care:presentation"],
 ["care.device","care:presentation"]
 ],
 "numbers":[
 [["measure.net_mass"],"N",["mg","g","kg"],"ALL","F","P","ALL:content"],
 [["measure.net_volume"],"N",["ml","l"],"ALL","F","P","ALL:content"],
 [["measure.content_count"],"N",["piece","dose_unit","sheet","roll"],"ALL","D","I","ALL:content"],
 [["measure.pack_count"],"N",["unit"],"ALL","D","I","ALL:optional"],
 [["measure.dimensions.external_length","measure.dimensions.external_width","measure.dimensions.external_height","measure.dimensions.external_diameter","measure.dimensions.internal_length","measure.dimensions.internal_width","measure.dimensions.internal_height","measure.dimensions.internal_diameter"],"N",["mm","cm","m"],"DIM","F","P","toy:dimensions,hygiene:optional,accessory:optional,habitat:space,care:optional"],
 [["measure.fit.neck","measure.fit.chest","measure.fit.back_length"],"R",["cm","mm"],"accessory","F","F","accessory:fit"],
 [["measure.animal_mass"],"R",["g","kg"],"ALL","F","P","ALL:optional"],
 [["measure.capacity.container"],"N",["ml","l"],"accessory,habitat","F","P","accessory:capacity,habitat:space"],
 [["measure.capacity.habitat_usable_volume"],"N",["ml","l"],"habitat","F","P","habitat:space"],
 [["measure.equipment.power"],"N",["W"],"EQUIP","D","F","accessory:optional_equipment,habitat:equipment"],
 [["measure.equipment.voltage"],"N",["V"],"EQUIP","D","F","accessory:optional_equipment,habitat:equipment"],
 [["measure.equipment.frequency"],"N",["Hz"],"EQUIP","D","F","accessory:optional_equipment,habitat:equipment"],
 [["measure.equipment.flow"],"N",["l/h"],"EQUIP","D","F","accessory:optional_equipment,habitat:equipment"],
 [["measure.equipment.temperature"],"R",["°C"],"EQUIP","D","F","accessory:optional_equipment,habitat:equipment"],
 [["measure.coverage.length"],"N",["m"],"COVER","D","P","hygiene:content,habitat:content"],
 [["measure.coverage.area"],"N",["m²"],"COVER","D","P","hygiene:content,habitat:content"]
 ],
 "other":[
 ["text.ingredients","T","food,treat","D"], ["text.protein_origin","T","food,treat","D"],
 ["text.composition","T","food,treat,care","D"], ["text.manufacturer_care","T","toy,hygiene,accessory,habitat,care","D"],
 ["text.instructions","T","ALL","D"], ["text.clinical_analysis","T","food,treat,care","I"],
 ["text.concentration","T","care","I"], ["text.regulatory_warnings","T","care","I"],
 ["feature.washable","B","hygiene,accessory,habitat","D"], ["feature.reusable","B","hygiene,accessory,habitat","D"], ["feature.waterproof","B","hygiene,accessory,habitat","D"]
 ],
 "overlay":[["hygiene.form.bag","Bolsa"],["hygiene.form.pad","Tapete absorbente"],["hygiene.form.diaper","Pañal"]],
 "aliases":[["cobaya","ani.dom.guinea_pig"],["cuyo","ani.dom.guinea_pig"],["cuy","ani.dom.guinea_pig"],["conejillo de Indias","ani.dom.guinea_pig"],["ninfa","ani.bird_pet.cockatiel"],["carolina","ani.bird_pet.cockatiel"],["asno","ani.equine.donkey"],["burro","ani.equine.donkey"]]
}
```

## 2. Total rule/outcome semantics (one result, once)

Outcomes [applicability,required,allowNA,evidenceRequired,documentary]: O=[applicable,false,false,true,resolved], R=[applicable,true,false,true,resolved], N=[not_applicable,false,true,true,resolved], U=[unresolved,false,false,true,resolved]. Documentary resolved means this policy is specified, NEVER actual care/legal clearance. Conflicts yield U/reject when evaluated. For E, independently reject a known false fit/capacity/electrical flag with its known nonempty subset, mismatched toyTypes, or content.kind contradicting known contentMagnitude, even if no attribute assertion seeds a rule; missing optional inputs alone are not conflicts.
The checker function `resolve` below is the normative finite decision table over **already shape/evidence-validated** facts: missing/None=omitted/unknown; false/[] are explicit evidenced known findings. It covers every route, family and parameter without expression evaluation. Project declaration key→value only for known, otherwise None: dimensions=relevantDimensionCodes.codes, fits=relevantFitCodes, capacities=relevantCapacityCodes, equipment=relevantEquipmentCodes; all other helper keys equal declaration keys. Before resolving E, require dimension toyTypes=selected known toy.type exactly for toy (including empty negative findings), [] otherwise. Fact evidence validation precedes trusting any negative.
Content: mass selects required net_mass; volume/count/length/area select their matching measure where bound. All other bound measures are O, not NA/incompatible, and may be independently evidenced; pack_count never substitutes. content.kind, if asserted, describes the selected contentMagnitude; additional measures do not silently change that selection. Hygiene consumable=false gives N only for consumable form/content minima; unknown consumable/content blocks affected minima, not other families' optional content.
Subset positive: selected axes required only for the existing toy/accessory/habitat minima; omitted axes O, NEVER inferred absent. Explicit evidenced empty set authorizes N for that conditional dimension/capacity minimum. Flag false authorizes N for its fit/capacity/electrical minimum; nonempty subset or known associated assertion contradicts it. True with unknown/empty subset is U. Care presentation selects one required representation; other representation bindings O, not inferred nonexistent.
Optional nonpertinence uses only the addendum's evidenced optionalNonpertinenceCodes list, restricted to optional-route parameters of this family. A missing/unknown/list-not-containing-code yields O; listed code N. It cannot waive required/conditional routes. Known false boolean or optional known empty multi is still a known assertion requiring evidence, not an NA declaration.
Consumption: R requires known nonempty single/text/multi (trim only for emptiness check), or a valid number/range/boolean; unknown/omission/NA fails. O permits omission/unknown; known requires evidence, false/empty optional value allowed; NA fails. N permits omission/unknown, explicit NA allowed; known assertion is contradictory (save structurally valid for correction, publish reject). U blocks evaluated publication; omission/unknown is not a waiver. Fresh explicit NA save is admitted only from the chosen route's resolved N, no later option-case override. Never normalize/delete stored contradictions.
Unknown optional rules do not seed evaluation; all always rules run for E even for missing assignments. Known fact negatives/empty subsets require evidence on save; missing per-value evidence saves incompletely but blocks known assertion publication. Numeric/reference validation, known-fact consistency, value evidence and care confirmation remain independent of this result. No invented law, source authenticity or subtype fact inference.

## 3. Deterministic provisioning and scope

Resolve actual existing unique family/definition codes within existing authorized vocabulary scope; options by (resolved definitionId,code), units by that definition+unit code. Reuse actual IDs, never equate canonical code with a DB ID. Generate new opaque DB IDs only for absent rows during separately authorized apply; dry-run uses symbolic code references only. Identity/type/owner collisions reject, not reinterpret with existing data.
Initial family order is food,treat,toy,hygiene,accessory,habitat,care; initial labels=family codes. Definition order: first occurrence in the 67 normalized source rows, then expanded numeric rows above, then text rows then boolean rows above. Initial definition labels=exact canonical codes (technical defaults). Binding sortOrder=that definition's zero-based global ordinal; omitted family bindings are not synthesized.
Each source row is one group under its declared definition. Group label=source row's second cell: animal caption, life application group, or first descriptor segment before ` · ` for attribute rows. Option labels remain byte-exact source labels; option sortOrder is zero-based occurrence within its definition over source rows/pair order. S7 options append bag,pad,diaper to hygiene.form after all eight original members of that group. No new group/definition for overlays or material.rigid.
Unit sortOrder follows declared units array (zero-based), label=unit code, named code exact. Group/option/alias memberships expand literally from immutable normalized rows and the JSON additions; approved alias labels/targets above belong only to animal.target. Selection definitions without aliases emit aliases=[]; groups have no aliases key. No ambiguous alias activation or animal/life expansion. No source reference/date typed definitions.
Preserve existing custom labels/order/aliases/archive timestamps; missing entries add only; conflicting alias targets or identity/type/owner abort. Never reset order of existing rows to these initial ordinals or unarchive by omission. New groups/options/units are resolved against actual persisted IDs. Wire array ordering for R is code/label/sortOrder as wire §6, not DB-ID order; lock ordering remains the existing coordinated DB-ID order. Source-order ordinals are defaults, not R's object/array ordering algorithm.

## 4. Read-only documentation checker (no production tests)

Run exactly from repository root after reading this code; no network/DB/writes or generated executable file. Node is used only for the exact wire canonical serializer/SHA256 over synthetic wire fixtures, not observed production state. Semantic vectors exercise this proposed table, not backend behavior. Equal canonical input hash assertions alone are not implementation proof.

```sh
python3 -c 'from pathlib import Path; t=Path("docs/catalog-editorial-production-vocabulary-policy-mapping.md").read_text(); exec(t.split("```python\n",1)[1].split("\n```",1)[0])'
```

```python
import json, re, hashlib, subprocess, copy
from pathlib import Path
text = Path('docs/catalog-editorial-production-vocabulary-policy-mapping.md').read_text()
m = json.loads(re.search(r'```json\n(.*?)\n```', text, re.S)[1])
n = Path('docs/editorial-vocabulary-normalized-proposal.md').read_bytes()
s = Path('docs/editorial-vocabulary-source-snapshot.md').read_bytes()
assert hashlib.sha256(n).hexdigest() == '1dc079543c8607c8d984f548ec22d21c4092f342577c7c2e14dba7c5467488a9'
assert hashlib.sha256(s).hexdigest() == '2ce7b92a4866c3693a7a373fe0e1cbc7199b67e0c3a1e66725534fed9c8a8205'
n = n.decode(); rows = json.loads(re.search(r'```json\n(.*?)\n```', n, re.S)[1])
ALL = ['food','treat','toy','hygiene','accessory','habitat','care']
groups = {'ALL':ALL,'all seven':ALL,'TARGET':ALL,'DIM':['toy','hygiene','accessory','habitat','care'],'EQUIP':['accessory','habitat'],'COVER':['hygiene','habitat']}
def fs(v): return groups.get(v, v.split(','))
ids = {'required','optional','animal','form','content','dimensions','fit','capacity','space','equipment','optional_equipment','presentation'}
def dispatch(spec):
    out = {}
    for token in spec.split(','):
        family, rule = token.split(':'); assert rule in ids
        for f in fs(family): assert f in ALL and f not in out; out[f] = rule
    return out
assert m['semanticsVersion']=='editorial-production-1'
expected = {}; opts = {}; choice = {}; definitions = {}; bindings = {}; source_lines=s.decode().splitlines()
for line_no, group, code, families, typ, exposure, pairs in rows:
    choice.setdefault(code, {'id':'fixture:'+code,'code':code,'label':code,'type':{'U':'single','M':'multi'}[typ],'options':[],'groups':[],'aliases':[]})
    members = []
    for pair in pairs.split('; '):
        key, label = pair.split('=',1); op = group+'.'+key; assert op not in opts; opts[op] = label; members.append(op)
        choice[code]['options'].append({'code':op,'label':label,'archived':False,'sortOrder':len(choice[code]['options'])})
    caption=source_lines[line_no-1].split('|')[2].strip().split(' · ')[0]
    choice[code]['groups'].append({'code':group,'label':caption,'optionCodes':members})
    for f in families: expected[f,code] = exposure
assert len(rows)==67 and len(opts)==514 and len(choice)==32
for op,label in m['overlay']:
    assert op not in opts; opts[op]=label; d=choice['hygiene.form']; d['options'].append({'code':op,'label':label,'archived':False,'sortOrder':len(d['options'])}); d['groups'][0]['optionCodes'].append(op)
assert len(opts)==517
for label,op in m['aliases']: assert op in opts; choice['animal.target']['aliases'].append({'label':label,'optionCode':op})
num_expected = {}; other_expected = {}
for line in n.splitlines():
    cells = [c.strip() for c in line.split('|')[1:-1]]
    if line.startswith('| `measure.'):
        codes = re.findall(r'`(measure\.[^`]+)`', cells[0]); families,exposure = cells[3].split(' / ')
        for code in codes:
            num_expected[code] = (fs(families),exposure,cells[2].split(','),'R' if cells[1].startswith(('R','each R')) else 'N','I' if 'integer' in cells[1] else 'P' if '> 0' in cells[1] else 'F')
    if line.startswith('| `text.') or line.startswith('| `feature.'):
        other_expected[cells[0].strip('`')] = (cells[1],fs(cells[2]),cells[3])
assert len(num_expected)==25 and len(other_expected)==11 and sum(x[0]=='T' for x in other_expected.values())==8 and sum(x[0]=='B' for x in other_expected.values())==3
routes = {}
for code,spec in m['choices']: assert code not in routes; routes[code] = dispatch(spec)
assert set(routes)==set(choice)
for codes,typ,units,families,exposure,domain,spec in m['numbers']:
    for code in codes:
        assert code in num_expected and code not in routes and num_expected[code]==(fs(families),exposure,units,typ,domain), (code,num_expected.get(code),(fs(families),exposure,units,typ,domain))
        routes[code] = dispatch(spec); assert set(routes[code])==set(fs(families))
        definitions[code]={'id':'fixture:'+code,'code':code,'label':code,'type':{'N':'number','R':'range'}[typ],'units':[{'code':u,'label':u,'sortOrder':i} for i,u in enumerate(units)],'numericPolicy':{'status':'resolved','magnitude':code,'integer':domain=='I','lower':0 if domain in ['P','I'] else None,'lowerInclusive':False,'upper':None,'upperInclusive':False}}
        for f in fs(families): expected[f,code]=exposure
for code,typ,families,exposure in m['other']:
    assert other_expected[code]==(typ,fs(families),exposure) and code not in routes, (code,other_expected[code],(typ,fs(families),exposure))
    routes[code]={f:'optional' for f in fs(families)}; definitions[code]={'id':'fixture:'+code,'code':code,'label':code,'type':{'T':'text','B':'boolean'}[typ]}
    for f in fs(families): expected[f,code]=exposure
assert set(definitions)==set(num_expected)|set(other_expected) and len(routes)==68
numeric={c:(typ,units,domain) for codes,typ,units,ff,ee,domain,rr in m['numbers'] for c in codes}
def numeric_ok(c,value,unit):
    import math
    typ,units,domain=numeric[c]; vs=value if isinstance(value,list) else [value]
    return unit in units and len(vs)==(2 if typ=='R' else 1) and all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) and (domain=='F' or v>0) and (domain!='I' or float(v).is_integer()) for v in vs) and (typ!='R' or vs[0]<=vs[1])
for c,(typ,units,domain) in numeric.items():
    assert numeric_ok(c,[1,2] if typ=='R' else 1,units[0]) and not numeric_ok(c,[1,2] if typ=='R' else 1,None)
    assert numeric_ok(c,[-1,0] if typ=='R' else -1,units[0])==(domain=='F')
    assert not numeric_ok(c,[2,1] if typ=='R' else float('inf'),units[0])
    if domain=='I': assert not numeric_ok(c,1.5,units[0])
def check_mode(f,r): return 'always' if r in {'required','animal','form','fit','capacity','space','presentation','dimensions','equipment'} or (r=='content' and f in {'food','treat','hygiene','care'}) else 'when_asserted'
ordinals={c:i for i,c in enumerate(list(choice)+list(definitions))}
assert {r for rr in routes.values() for r in rr.values()}==ids
for code,rr in routes.items():
    for f,r in rr.items():
        assert (f,code) in expected and (f,code) not in bindings
        bindings[f,code]={'definitionId':'fixture:'+code,'definitionCode':code,'owner':'sellable','sortOrder':ordinals[code],'exposure':{'F':'FACET','D':'DETAIL','I':'INTERNAL'}[expected[f,code]],'searchable':False,'publicationCheck':check_mode(f,r),'policy':{'route':'fact_rule','rule':{'family':f,'ruleId':r,'parameter':code}}}
assert set(bindings)==set(expected) and all(b['policy']['route']=='fact_rule' for b in bindings.values())
content = dict(zip(['mass','volume','count','length','area'],['measure.net_mass','measure.net_volume','measure.content_count','measure.coverage.length','measure.coverage.area']))
def subset(c,x,required=True): return 'U' if x is None else ('N' if not x else ('R' if required and c in x else 'O'))
def flag(c,x,ss,required=True):
    if x is False: return 'U' if ss else 'N'
    if x is True: return 'U' if not ss else subset(c,ss,required)
    return 'U' if required else 'O'
def resolve(f,c,r,x):
    if r=='required': return 'R'
    if r=='optional': return 'N' if c in (x.get('optionalNonpertinenceCodes') or []) else 'O'
    if r in {'animal','form'}: return 'N' if x.get('animalApplied' if r=='animal' else 'consumable') is False else ('R' if x.get('animalApplied' if r=='animal' else 'consumable') is True else 'U')
    if r=='content':
        if f not in {'food','treat','hygiene','care'}: return 'O'
        if f=='hygiene' and x.get('consumable') is False: return 'N'
        if f=='hygiene' and x.get('consumable') is not True: return 'U'
        k=x.get('contentMagnitude'); return 'U' if k not in content or (f=='treat' and k not in {'mass','volume','count'}) else ('R' if c==content[k] else 'O')
    if r=='dimensions': return subset(c,x.get('dimensions'))
    if r=='space':
        if x.get('dimensions') is None or x.get('capacities') is None: return 'U'
        return subset(c,x['dimensions'] if c.startswith('measure.dimensions.') else x['capacities'])
    if r in {'fit','capacity','equipment','optional_equipment'}:
        a,b={'fit':('fitDeterminesChoice','fits'),'capacity':('capacityDeterminesChoice','capacities'),'equipment':('electricalApplies','equipment'),'optional_equipment':('electricalApplies','equipment')}[r]
        return flag(c,x.get(a),x.get(b),r!='optional_equipment')
    if r=='presentation': return 'U' if x.get('presentationKind') not in {'formulation','device','packaging'} else ('R' if c=={'formulation':'care.form','device':'care.device','packaging':'pack.form'}[x['presentationKind']] else 'O')
    raise AssertionError(r)
def accepts(out,state,nonempty=True,evidence=True): return out!='U' and (state in {'omitted','unknown'} and out!='R' or state=='NA' and out=='N' or state=='known' and out in {'O','R'} and evidence and (out!='R' or nonempty))
truth={'O':[True,True,True,False],'R':[False,False,True,False],'N':[True,True,False,True],'U':[False,False,False,False]}
for out,answers in truth.items(): assert [accepts(out,s) for s in ['omitted','unknown','known','NA']]==answers
for f,c in bindings:
    r=bindings[f,c]['policy']['rule']['ruleId']; expected_unknown='R' if r=='required' else 'O' if r in {'optional','optional_equipment'} or (r=='content' and f not in {'food','treat','hygiene','care'}) else 'U'
    assert resolve(f,c,r,{})==expected_unknown and resolve(f,c,r,dict.fromkeys(['contentMagnitude','consumable','animalApplied','dimensions','fits','capacities','equipment','fitDeterminesChoice','capacityDeterminesChoice','electricalApplies','presentationKind']))==expected_unknown
    if r=='optional': assert resolve(f,c,r,{'optionalNonpertinenceCodes':[c]})=='N' and resolve(f,c,r,{'optionalNonpertinenceCodes':[]})=='O'
    if r in {'animal','form'}:
        k='animalApplied' if r=='animal' else 'consumable'; assert [resolve(f,c,r,{k:b}) for b in [True,False]]==['R','N']
    if r in {'fit','capacity','equipment','optional_equipment'}:
        a,b={'fit':('fitDeterminesChoice','fits'),'capacity':('capacityDeterminesChoice','capacities'),'equipment':('electricalApplies','equipment'),'optional_equipment':('electricalApplies','equipment')}[r]
        assert [resolve(f,c,r,{a:v,b:ss}) for v,ss in [(True,[]),(False,[]),(False,[c]),(True,[c])]]==['U','N','U','O' if r=='optional_equipment' else 'R']
    if r=='content':
        for k,selected in content.items():
            if (f,selected) in bindings and not (f=='treat' and k not in {'mass','volume','count'}): assert resolve(f,c,r,{'consumable':True,'contentMagnitude':k})==('R' if f in {'food','treat','hygiene','care'} and c==selected else 'O')
    if r in {'space','dimensions'}: assert [resolve(f,c,r,{'dimensions':ss,'capacities':ss}) for ss in [[],[c],['not-this-axis']]]==['N','R','O']
    if r=='presentation': assert [resolve(f,c,r,{'presentationKind':k}) for k in ['formulation','device','packaging']]==['R' if c==d else 'O' for d in ['care.form','care.device','pack.form']]
for f in ALL:
    root={'food':'food.format','treat':'treat.form','toy':'toy.type','hygiene':'hygiene.type','accessory':'accessory.type','habitat':'habitat.type','care':'care.type'}[f]
    assert resolve(f,root,routes[root][f],{})=='R' and not accepts('R','known',False)
assert resolve('hygiene','animal.target','animal',{'animalApplied':False})=='N'
assert resolve('hygiene','hygiene.form','form',{'consumable':False})=='N'
assert resolve('hygiene','measure.net_mass','content',{'consumable':False})=='N'
assert resolve('toy','measure.dimensions.external_width','dimensions',{'dimensions':['measure.dimensions.external_length']})=='O'
assert resolve('food','measure.net_volume','content',{'contentMagnitude':'mass'})=='O'
for r,a,b in [('fit','fitDeterminesChoice','fits'),('capacity','capacityDeterminesChoice','capacities'),('equipment','electricalApplies','equipment')]:
    assert flag('c',False,['c'])=='U' and resolve('accessory' if r!='equipment' else 'habitat','c',r,{a:True,b:[]})=='U'
assert accepts('O','known',False) and accepts('O','known',True) and not accepts('O','known',True,False)
assert accepts('N','omitted') and accepts('N','unknown') and accepts('N','NA') and not accepts('O','NA')
assert resolve('habitat','measure.capacity.container','space',{'dimensions':[],'capacities':[]})=='N'
assert resolve('care','care.device','presentation',{'presentationKind':'formulation'})=='O'
review={'state':'prepared','jurisdiction':'synthetic','intendedUse':'synthetic','determination':'none_applicable','evidence':[{'sourceRef':'fixture','verifiedOn':'2026-01-01'}],'basis':'synthetic documented determination','requirements':[],'warnings':[]}
E={'A'}; doc={'schemaVersion':2,'commercialTitle':'Fixture','description':None,'mediaRefs':[],'familyCode':'care','values':[],'facts':[{'variantId':'A','presentation':'A','declarations':[],'careReview':review},{'variantId':'B','presentation':'B','declarations':[],'careReview':{'state':'unknown'}}]}
def review_valid(r):
    if r.get('state')!='prepared' or not all(r.get(k) for k in ['jurisdiction','intendedUse','basis','evidence']): return False
    if r['determination']=='none_applicable': return r['requirements']==[] and r['warnings']==[]
    return r['determination']=='identified' and bool(r['requirements']) and all(q['disposition'] in {'satisfied','not_applicable'} and q['evidence'] and q['basis'] for q in r['requirements']) and all(w['disclosure']=='private_only' and w['evidence'] and w['handlingBasis'] for w in r['warnings'])
def reviewed(e): return all(len([r for r in doc['facts'] if r['variantId']==i and review_valid(r['careReview'])])==1 for i in e)
assert len({r['variantId'] for r in doc['facts']})==len(doc['facts']) and reviewed(E) and not reviewed({'A','B'}) and not reviewed({'missing'})
bad=copy.deepcopy(review); bad['evidence']=[]; assert not review_valid(bad)
subjects=[{'variantId':r['variantId'],'presentation':r['presentation']} for r in doc['facts'] if r['variantId'] in E]
assert subjects==[{'variantId':'A','presentation':'A'}] and len(doc['facts'])==2
changed=copy.deepcopy(doc); changed['facts'][1]['presentation']='inactive change'; assert changed!=doc
v={'semanticsVersion':m['semanticsVersion'],'families':[{'id':'fixture:'+f,'code':f,'label':f,'minimumContractVersion':2,'bindings':[b for (ff,c),b in bindings.items() if ff==f]} for f in ALL],'definitions':list(choice.values())+list(definitions.values())}
js=r'''
const crypto=require('node:crypto'), input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const cmp=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
function scalar(s){for(let i=0;i<s.length;i++){let n=s.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){let m=s.charCodeAt(++i);if(!(m>=0xdc00&&m<=0xdfff))throw Error('surrogate');}else if(n>=0xdc00&&n<=0xdfff)throw Error('surrogate');}return '"'+[...s].map(c=>c==='"'?'\\"':c==='\\'?'\\\\':c.charCodeAt(0)<32?'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'):c).join('')+'"';}
function enc(x){if(x===null)return 'null';if(typeof x==='string')return scalar(x);if(typeof x==='boolean')return String(x);if(typeof x==='number'){if(!Number.isFinite(x))throw Error('finite');return JSON.stringify(x);}if(Array.isArray(x))return '['+x.map(enc).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort(cmp).map(k=>scalar(k)+':'+enc(x[k])).join(',')+'}';throw Error('JSON');}
function order(v){v.families.sort((a,b)=>cmp(a.label,b.label)||cmp(a.code,b.code));v.definitions.sort((a,b)=>cmp(a.code,b.code));for(const f of v.families){f.bindings.sort((a,b)=>a.sortOrder-b.sortOrder||cmp(a.definitionCode,b.definitionCode));for(const b of f.bindings)if(b.policy.route==='option_cases'){b.policy.cases.sort((a,b)=>cmp(a.code,b.code));for(const c of b.policy.cases){c.when.sort((a,b)=>cmp(a.definitionCode,b.definitionCode));for(const t of c.when)t.optionCodes.sort(cmp);}}}for(const d of v.definitions){for(const key of ['options','units'])if(d[key])d[key].sort((a,b)=>a.sortOrder-b.sortOrder||(a.code===null?-1:b.code===null?1:cmp(a.code,b.code)));if(d.groups){d.groups.sort((a,b)=>cmp(a.code,b.code));for(const g of d.groups)g.optionCodes.sort(cmp);}if(d.aliases)d.aliases.sort((a,b)=>cmp(a.label,b.label)||cmp(a.optionCode,b.optionCode));}return v;}
const hash=x=>crypto.createHash('sha256').update(enc(x),'utf8').digest('hex');
const v=order(input.v), r=hash({contractVersion:2,vocabulary:v});const next=structuredClone(v);next.semanticsVersion='editorial-production-2';
if(enc({a:'"\\\n',n:-0})!=='{"a":"\\"\\\\\\u000a","n":0}')throw Error('escaping');
process.stdout.write(JSON.stringify([r,hash({contractVersion:2,vocabulary:next}),hash({cycle:1,draftRevision:1,document:input.doc}),hash({cycle:1,draftRevision:1,document:input.changed})]));
'''
hashes=json.loads(subprocess.check_output(['node','-e',js],input=json.dumps({'v':v,'doc':doc,'changed':changed},ensure_ascii=False).encode()))
assert all(re.fullmatch('[0-9a-f]{64}',h) for h in hashes) and hashes[0]!=hashes[1] and hashes[2]!=hashes[3]
print(f'PASS: {len(bindings)} total exclusive bindings; 517 options/32 choices/25 numeric/8 text/3 boolean; closed IDs/version; all-binding branch vectors; E filtering/inactive retention')
print('PASS: exact canonical serializer/SHA256 over synthetic expanded wire metadata and whole-document digest fixtures; semantics/inactive change hashes differ; NOT production behavior proof')
```

## Key Learnings

1. A fact-authorized NA is one dispatch result, not a prelude to an option rule requiring the same value again.
2. E limits publication/attestation subjects; inactive valid capture remains in the whole-document digest.
3. Relevant subset exclusion is optionality, not proof of nonexistence; explicit evidenced negative determinations are separate.
