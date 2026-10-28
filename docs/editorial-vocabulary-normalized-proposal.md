# Normalized production vocabulary proposal — T2 attachment

**Proposal only; not a production manifest, business approval, or implementation authorization.** This attachment provides the complete candidate inventory and a deterministic semantic applicability proposal for the pending wire v0.3 draft contract (superseding the evaluator alignment to v0.2). It authorizes no UI, source, schema, database, seed, deployment, commit, or push. Examples are semantic payload drafts, not approved transport shapes.

## 1. Authority and review path

Source: [product-vocabularies.md](product-vocabularies.md), Git blob `9538de694f1125e79e5f2b60e2e4eb49b2e0a05d`. The source was read completely before use; `git hash-object` matched that blob and `git cat-file -t` returned `blob`. References `V75` mean line 75 in that exact blob, not HEAD. Review §3 inventory first, §4 units next, then §5 applicability and §6 unresolved cells.

Precedence: the relayed closed S4–S6 decisions and explicit assignment conservation instruction supplement/supersede the source where stated below. D14 minima in source §7 remain approved and unchanged. Technical canonical codes in this document are resolved proposal choices, **not database IDs**, approved seeds, or claims that backend supports them today. Database references must resolve independently within authorized scope; never synthesize a DB ID from a code.

### Fixed policies

- Families: `food`, `treat`, `toy`, `hygiene`, `accessory`, `habitat`, `care`. Family, commercial title and description remain separate product-document fields, not typed inventory assignments. Operational name/SKU/stock/pricing/recipe/unit/visibility remain live and outside this artifact.
- Every typed definition below has fixed `ownerScope: sellable` for every listed family, including evidence metadata. Simple product: its one sellable identity stores assignments; variant product: each actual variant identity stores its own assignments. No inheritance, common-value copying, sibling join, product fallback, or operational fallback. Identical sibling values still need explicit assignments and evidence.
- Every definition has `searchable: false`. Public search reads only Published commercial title + description. Administrative vocabulary lookup by code/label/approved alias is separate, not public attribute search.
- `F` = filter + detail, `D` = detail only, `I` = internal only. These are fixed per-family bindings in this proposal, never permissions to expose private evidence. Public F/D values require Published state and current live commercial eligibility. Source/date/private documents remain I even when supporting public values.
- `mediaRefs: []` in examples; media implementation is out of scope. Maximum assignments remains 200 per applicable contract assignment collection; the 514 option dictionary does not raise that limit. Options are not assignments, variants, or SKU combinations.
- An archived option cannot receive a new assignment. Fresh save conserves against the persisted Draft baseline; publish conserves against current Published (null means no conserved assignments), using the existing qualified assignment identity/value rules. Do not add a second saved-Published-baseline requirement. A baseline alone cannot reintroduce an assignment no longer in current Published. Changed/reintroduced archived selections fail. Preserve references/history and warnings. This supersedes source §8's replace-before-republish instruction, not current variant eligibility or other publication checks; it does not grandfather deleted variants, invalid tenant references, or unsafe data.
- No animal-group expansion, scientific equivalence inference, stage inheritance, or compatibility inference. All multi-values are explicit selections. Material is ONE multiChoice definition `material`, with groups `material.base` and `material.rigid`, one assignment/facet and combined OR semantics. Shared `food.process` and `food.texture` each remain ONE definition across food/treat, not copied treat definitions.

## 2. Semantic normalization and evidence

### Identity and bindings

The inventory block in §3 is complete. Each row is:

`[sourceLine, groupCode, definitionCode, familyCodes, type, exposure, exactKeyLabelPairs]`.

`U` means singleChoice, `M` multiChoice. Each semicolon-delimited `key=label` pair expands to option code `groupCode + "." + key`, preserving label byte-for-byte. This is a lossless canonical encoding, not abbreviated option headlines. Row group codes are explicit option group identities, not selectable options or separate definitions. Animal rows share `animal.target`; life rows share `life.stage`. All other mappings are literal in the block. The listed family array defines separate, identical fixed bindings for each member: sellable, listed exposure, searchable false. No implicit binding to unlisted families.

An option belongs to its listed group and definition only. Administrative group captions/animal E/G level come from the cited source row; ani rows V75–96 preserve their E/G classification. Life rows V114–127 retain their exact application group and species/cycle restrictions. Selecting a group option does not select related options. Stage codes retain distinct group meaning even when labels match.

### Closed S4–S6 evidence/public text policy

Evidence is an internal association to a specific sellable identity, definition/value, manufacturer document scope and checked date. `source.reference` is documented internal text/reference, and `source.checked_at` a valid calendar-date text (`YYYY-MM-DD`), both I, sellable, all seven families, searchable false (V202, §2). Per-value evidence links are a semantic requirement, not a proposed evidence database schema. Private reference existence/authorization and date validity are structural checks; a title is not evidence.

Recipient (`animal.target`), compatibility declarations, stage (`life.stage`), composition and declared features require internal source + date whenever populated, including explicit false booleans. These are not all-optional/title-derived claims. Food recipients, treat recipients, toy recipients and conditionally required hygiene recipients remain required under D14. Optional declared facts may remain unknown without becoming mandatory. For any required claim, missing evidence blocks publication. Administrative animal classification is I and cannot satisfy recipient.

| Proposed definition code | Type | Families | Exposure | Source / policy |
| --- | --- | --- | --- | --- |
| `text.ingredients` | T | food,treat | D | V201; exact backed manufacturer statement only |
| `text.protein_origin` | T | food,treat | D | V201; no inferred origin from shape/base |
| `text.composition` | T | food,treat,care | D | V135,201,203; backed composition only, not clinical concentrations |
| `text.manufacturer_care` | T | toy,hygiene,accessory,habitat,care | D | V202 and S4; nonclinical manufacturer care only |
| `text.instructions` | T | all seven | D | S4; backed nonclinical instructions only |
| `text.clinical_analysis` | T | food,treat,care | I | V135,203 and S4; no public analysis without specific review |
| `text.concentration` | T | care | I | V203 and S4; no invented structured clinical units/doses |
| `text.regulatory_warnings` | T | care | I | V203 and S4; specific review required before public disclosure |
| `feature.washable` | B | hygiene,accessory,habitat | D | V202; declared true/false only |
| `feature.reusable` | B | hygiene,accessory,habitat | D | V202; declared true/false only |
| `feature.waterproof` | B | hygiene,accessory,habitat | D | V202; declared true/false only |

All rows in this table also use fixed sellable/searchable false. No generic public free-text slot bypasses S4. Private documents, source, date, clinical analyses, concentrations and regulatory warnings remain INTERNAL until specific review; store privately, redact from public projections/indexes/caches. A required warning may block publication while its approved disclosure treatment is unresolved; storing private text does not itself approve publication. Unsupported health claims (hypoallergenic, renal, antiparasitic, dental, etc.) are not inferred or new options. Compatibility, if documented, uses exact explicit recipient selections and scoped evidence; no new unbounded public compatibility text field.

Approved exact aliases (S6, superseding source's regional activation caveat): `ani.dom.guinea_pig` ↔ «cobaya», «cuyo», «cuy», «conejillo de Indias»; `ani.bird_pet.cockatiel` ↔ «ninfa», «carolina»; `ani.equine.donkey` ↔ «asno», «burro». Canonical labels retain original capitalization. Aliases create neither options nor faceted counts. «Hámster ruso», «periquito», «tortuga», «pez ángel», «cangrejo» require identification; suggestions are not assignments. Koi and mules retain source commercial grouping; breed/variety remains outside this inventory. No group expansion or inheritance, including overlapping python/axolotl groups or invertebrate stages.

## 3. Complete selectable inventory: 67 source rows / 514 options

The JSON contains exactly 22 animal rows / 112 pairs, 14 life rows / 72 pairs and 31 selectable attribute rows / 330 pairs. These normalize to 32 choice definitions, not 67 definitions or 514 required assignments. Unit tokens, aliases, capture states and non-choice definitions are outside the 514.

```json
[
[75,"ani.dom","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","dog=Perro; cat=Gato; rabbit=Conejo doméstico; ferret=Hurón doméstico; guinea_pig=Cobaya"],
[76,"ani.small","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","syrian_hamster=Hámster sirio; roborovski=Hámster de Roborovski; degu=Degú; fancy_rat=Rata doméstica; house_mouse=Ratón doméstico"],
[77,"ani.small_group","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","dwarf_hamsters=Hámsteres enanos; gerbils=Jerbos; hedgehogs=Erizos; sugar_gliders=Petauros; dormice=Lirones; chinchillas=Chinchillas domésticas"],
[78,"ani.bird_pet","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","canary=Canario doméstico; budgerigar=Periquito australiano; cockatiel=Ninfa; zebra_finch=Diamante mandarín; java_sparrow=Gorrión de Java"],
[79,"ani.bird_group","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","lovebirds=Agapornis; parrots=Loros; macaws=Guacamayas; cockatoos=Cacatúas; conures=Cotorras y conuros; finches=Pinzones ornamentales"],
[80,"ani.poultry","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","chicken=Gallina doméstica; turkey=Pavo doméstico; guinea_fowl=Gallina de Guinea; pigeon=Paloma doméstica"],
[81,"ani.poultry_group","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","ducks=Patos domésticos; geese=Gansos domésticos; quail=Codornices; pheasants=Faisanes; peafowl=Pavos reales; ratites=Ratites de granja"],
[82,"ani.lizard","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","leopard_gecko=Gecko leopardo; crested_gecko=Gecko crestado; green_iguana=Iguana verde"],
[83,"ani.lizard_group","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","geckos=Geckos; chameleons=Camaleones; anoles=Anolis; skinks=Escíncidos; monitors=Varanos; bearded_dragons=Dragones barbudos"],
[84,"ani.snake","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","corn_snake=Serpiente del maíz; ball_python=Pitón bola"],
[85,"ani.reptile_group","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","boas=Boas; pythons=Pitones; kingsnakes=Serpientes rey; tortoises=Tortugas terrestres; aquatic_turtles=Tortugas acuáticas; semiaquatic_turtles=Tortugas semiacuáticas"],
[86,"ani.amphibian","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","axolotl=Ajolote mexicano; african_clawed_frog=Rana de uñas africana"],
[87,"ani.amphibian_group","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","frogs=Ranas; toads=Sapos; tree_frogs=Ranas arborícolas; newts=Tritones; salamanders=Salamandras"],
[88,"ani.freshwater","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","goldfish=Pez dorado; guppy=Guppy; neon_tetra=Tetra neón; cardinal_tetra=Tetra cardenal; zebrafish=Pez cebra"],
[89,"ani.freshwater_group","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","bettas=Bettas; mollies=Mollys; platies=Platys; swordtails=Colas de espada; corydoras=Corydoras; plecos=Plecos; cichlids=Cíclidos; gouramis=Guramis; discus=Peces disco"],
[90,"ani.aquatic_other","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","koi=Carpas koi; pond_fish=Peces de estanque; brackish_fish=Peces de agua salobre"],
[91,"ani.marine","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","clownfish=Peces payaso; surgeonfish=Peces cirujano; marine_angelfish=Peces ángel marinos; gobies=Gobios marinos; blennies=Blénidos marinos; damselfish=Damiselas; wrasses=Lábridos; butterflyfish=Peces mariposa"],
[92,"ani.aquatic_invert","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","freshwater_shrimp=Camarones de agua dulce; freshwater_snails=Caracoles de agua dulce; crayfish=Cangrejos de río; marine_shrimp=Camarones marinos; hermit_crabs=Cangrejos ermitaños marinos; corals=Corales; anemones=Anémonas marinas; marine_snails=Caracoles marinos"],
[93,"ani.equine","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","horse=Caballo; donkey=Asno"],
[94,"ani.equine_group","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","mules=Mulas y burdéganos"],
[95,"ani.farm","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","cattle=Bovino doméstico; sheep=Ovino doméstico; goat=Caprino doméstico; pig=Cerdo doméstico; water_buffalo=Búfalo de agua doméstico; llama=Llama; alpaca=Alpaca"],
[96,"ani.terrestrial_invert","animal.target",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","tarantulas=Tarántulas; scorpions=Escorpiones; mantises=Mantis; stick_insects=Insectos palo; beetles=Escarabajos; isopods=Isópodos terrestres; land_snails=Caracoles terrestres; bees=Abejas"],
[114,"life.dog","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","nursing=Lactante; puppy=Cachorro; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia"],
[115,"life.cat","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","nursing=Lactante; kitten=Gatito; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia"],
[116,"life.small","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","nursing=Lactante; juvenile=Juvenil; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia"],
[117,"life.bird","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","chick=Polluelo; fledgling=Volantón; juvenile=Juvenil; adult=Adulto; breeding=Reproducción; laying=Puesta"],
[118,"life.poultry","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","starter=Inicio; grower=Crecimiento; developer=Desarrollo; finisher=Finalización; layer=Postura; breeder=Reproductor"],
[119,"life.reptile","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","hatchling=Recién eclosionado; juvenile=Juvenil; adult=Adulto; breeding=Reproducción"],
[120,"life.amphibian","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","larval=Larvaria; metamorph=Metamorfosis; juvenile=Juvenil; adult=Adulto"],
[121,"life.aquatic","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","larval=Larvaria; fry=Alevín; juvenile=Juvenil; adult=Adulto; broodstock=Reproductor"],
[122,"life.equine","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","nursing=Lactante; foal=Cría; growing=Crecimiento; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia"],
[123,"life.farm","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","nursing=Lactante; preweaning=Pre-destete; postweaning=Post-destete; growing=Crecimiento; finishing=Finalización; adult=Adulto; gestation=Gestación; lactation=Lactancia"],
[124,"life.crustacean","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","larval=Larvaria; postlarval=Postlarvaria; juvenile=Juvenil; adult=Adulto"],
[125,"life.insect_complete","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","egg=Huevo; larva=Larva; pupa=Pupa; adult=Adulto"],
[126,"life.insect_incomplete","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","egg=Huevo; nymph=Ninfa; adult=Adulto"],
[127,"life.arachnid","life.stage",["food","treat","toy","hygiene","accessory","habitat","care"],"M","F","juvenile=Juvenil; subadult=Subadulto; adult=Adulto"],
[139,"pack.form","pack.form",["food","treat","toy","hygiene","accessory","habitat","care"],"U","D","bag=Bolsa; sack=Saco; can=Lata; pouch=Sobre; tray=Bandeja; jar=Frasco; bottle=Botella; tube=Tubo; box=Caja; blister=Blíster; bucket=Cubeta; tub=Bote; wrap=Envoltura; bulk=Granel"],
[140,"pack.sale","pack.sale",["food","treat","toy","hygiene","accessory","habitat","care"],"U","D","single=Individual; multipack=Paquete múltiple; kit=Kit; pair=Par; case=Caja comercial; display=Exhibidor; refill=Recarga"],
[141,"content.kind","content.kind",["food","treat","toy","hygiene","accessory","habitat","care"],"U","D","mass=Masa; volume=Volumen; count=Conteo; length=Longitud; area=Superficie"],
[142,"material.base","material",["toy","hygiene","accessory","habitat"],"M","F","rubber=Caucho; latex=Látex; silicone=Silicona; tpr=Elastómero termoplástico; nylon=Poliamida; polyester=Poliéster; cotton=Algodón; hemp=Cáñamo; jute=Yute; sisal=Sisal; rope=Cuerda de fibra no especificada; fleece=Tejido polar; felt=Fieltro; plush=Tejido de peluche"],
[143,"material.rigid","material",["toy","hygiene","accessory","habitat"],"M","F","stainless=Acero inoxidable; steel=Acero; aluminium=Aluminio; plastic=Plástico no especificado; polypropylene=Polipropileno; polyethylene=Polietileno; abs=ABS; pvc=PVC; acrylic=Acrílico; glass=Vidrio; ceramic=Cerámica; wood=Madera; bamboo=Bambú; cardboard=Cartón; paper=Papel; stone=Piedra"],
[144,"color.base","color.base",["toy","accessory","habitat"],"M","F","black=Negro; white=Blanco; grey=Gris; brown=Café; beige=Beige; red=Rojo; orange=Naranja; yellow=Amarillo; green=Verde; blue=Azul; purple=Morado; pink=Rosa; transparent=Transparente; multicolor=Multicolor; assorted=Surtido"],
[145,"size.label","size.label",["toy","accessory"],"U","F","xxs=XXS; xs=XS; s=S; m=M; l=L; xl=XL; xxl=XXL; xxxl=XXXL; adjustable=Ajustable; one_size=Talla única"],
[146,"size.animal","size.animal",["food","treat","toy","accessory"],"M","F","miniature=Miniatura; small=Pequeño; medium=Mediano; large=Grande; giant=Gigante"],
[176,"food.format","food.format",["food"],"U","F","kibble=Croquetas; pellet=Pellets; flake=Hojuelas; granule=Gránulos; stick=Barritas; wafer=Discos alimenticios; pate=Paté; chunks=Trozos; mousse=Mousse; broth=Caldo; powder=Polvo; seed_mix=Mezcla de semillas; hay=Heno; forage=Forraje; frozen=Congelado; freeze_dried=Liofilizado"],
[177,"food.role","food.role",["food"],"U","F","complete=Alimento completo; complementary=Alimento complementario; supplemental=Suplemento alimenticio; milk_replacer=Sustituto lácteo; forage=Forraje; breeding_feed=Alimento para reproductores"],
[178,"food.process","food.process",["food","treat"],"M","D","extruded=Extruido; baked=Horneado; dehydrated=Deshidratado; freeze_dried=Liofilizado; canned=Enlatado; frozen=Congelado; air_dried=Secado al aire; cold_pressed=Prensado en frío"],
[179,"food.texture","food.texture",["food","treat"],"M","F","dry=Seca; moist=Húmeda; semimoist=Semihúmeda; soft=Blanda; crunchy=Crujiente; liquid=Líquida; gel=Gel"],
[180,"food.aquatic","food.aquatic",["food"],"U","F","floating=Flotante; slow_sinking=Hundimiento lento; sinking=De fondo; suspended=En suspensión"],
[181,"treat.form","treat.form",["treat"],"U","F","bite=Bocaditos; biscuit=Galleta; strip=Tira; cube=Cubo; stick=Palito; roll=Rollo; ring=Aro; knot=Nudo; braid=Trenza; bone_shape=Forma de hueso; lickable=Premio para lamer; paste=Pasta; dried_piece=Pieza deshidratada"],
[182,"treat.base","treat.base",["treat"],"M","D","rawhide=Carnaza de piel; meat=Carne; fish=Pescado; vegetable=Vegetal; cereal=Cereal; dairy=Lácteo; insect=Insectos"],
[183,"toy.type","toy.type",["toy"],"M","F","ball=Pelota; rope=Cuerda de juego; tug=Tirador; plush=Peluche; chew=Mordedor; puzzle=Rompecabezas; dispenser=Dispensador; wand=Varita; teaser=Señuelo; tunnel=Túnel; wheel=Rueda; swing=Columpio; mirror=Espejo; climbing=Trepa; floating=Juguete flotante"],
[184,"toy.feature","toy.feature",["toy"],"M","F","squeaker=Con sonido al presionar; crinkle=Con material crujiente; bell=Con cascabel; catnip=Contiene catnip; refillable=Rellenable; treat_dispensing=Dispensa premios; suction=Con ventosa; interactive=Interactivo; battery=Funciona con pilas; rechargeable=Recargable"],
[185,"hygiene.type","hygiene.type",["hygiene"],"U","F","shampoo=Champú; conditioner=Acondicionador; wipes=Toallitas; brush=Cepillo; comb=Peine; slicker=Carda; clipper=Cortadora; nail_clipper=Cortaúñas; file=Lima; towel=Toalla; pad=Tapete absorbente; diaper=Pañal; bag=Bolsa para residuos; litter=Arena sanitaria; scoop=Pala sanitaria; cleaner=Limpiador de entorno"],
[186,"hygiene.form","hygiene.form",["hygiene"],"U","F","liquid=Líquido; foam=Espuma; spray=Atomizador; gel=Gel; powder=Polvo; bar=Barra; wipe=Toallita; granule=Granulado"],
[187,"hygiene.litter","hygiene.litter",["hygiene"],"M","F","bentonite=Bentonita; silica=Sílice; paper=Papel; wood=Madera; corn=Maíz; tofu=Derivado de soya; walnut=Cáscara de nuez; grass=Fibras de pasto"],
[188,"hygiene.scent","hygiene.scent",["hygiene"],"U","D","unscented=Sin fragancia añadida; scented=Con fragancia; unspecified=Fragancia no especificada por fabricante"],
[189,"accessory.type","accessory.type",["accessory"],"U","F","collar=Collar; harness=Arnés; leash=Correa; long_line=Línea larga; tag=Placa; muzzle=Bozal; carrier=Transportadora; stroller=Carriola; bowl=Comedero; drinker=Bebedero; fountain=Fuente; bed=Cama; mat=Colchoneta; coat=Abrigo; boots=Botas; saddle_pad=Mantilla; halter=Cabezada de cuadra; lead_rope=Ramal"],
[190,"accessory.closure","accessory.closure",["accessory"],"M","D","buckle=Hebilla; quick_release=Broche de liberación rápida; hook_loop=Cierre de gancho y bucle; zipper=Cremallera; snap=Broche a presión; tie=Amarre; carabiner=Mosquetón; screw=Tornillo"],
[191,"accessory.feature","accessory.feature",["accessory"],"M","F","adjustable=Ajustable; reflective=Reflectante; padded=Acolchado; foldable=Plegable; removable_cover=Funda desmontable; nonslip=Base antideslizante; elevated=Elevado; double=Doble; portable=Portátil; wall_mount=Montaje en pared"],
[192,"habitat.type","habitat.type",["habitat"],"U","F","cage=Jaula; aviary=Aviario; hutch=Conejera; pen=Corral; terrarium=Terrario; paludarium=Paludario; aquarium=Acuario; pond=Estanque; coop=Gallinero; shelter=Refugio; nest=Nido; incubator=Incubadora; filter=Filtro; pump=Bomba; heater=Calentador; lamp=Lámpara"],
[193,"habitat.environment","habitat.environment",["habitat"],"M","F","terrestrial=Terrestre; arboreal=Arborícola; semiaquatic=Semiacuático; freshwater=Agua dulce; brackish=Agua salobre; marine=Marino; indoor=Interior; outdoor=Exterior"],
[194,"habitat.substrate","habitat.substrate",["habitat"],"M","F","coconut=Fibra de coco; bark=Corteza; soil=Tierra; sand=Arena; gravel=Grava; clay=Arcilla; paper=Papel; hemp=Cáñamo; straw=Paja; wood_shavings=Viruta de madera; moss=Musgo; mineral_mix=Mezcla mineral"],
[195,"habitat.component","habitat.component",["habitat"],"M","F","perch=Percha; platform=Plataforma; hide=Escondite; ramp=Rampa; feeder=Alimentador; dripper=Gotero; misting=Nebulización; thermostat=Termostato; thermometer=Termómetro; hygrometer=Higrómetro; timer=Temporizador; aeration=Aireación; lighting=Iluminación; filtration=Filtración"],
[196,"care.type","care.type",["care"],"U","F","grooming=Cuidado externo; oral_hygiene=Higiene oral; wound_supplies=Material de curación; dressing=Apósitos; bandage=Vendajes; protective_collar=Collar protector; instrument=Instrumental; dosing_device=Dispositivo de administración; supplement=Suplemento declarado; medicine=Medicamento declarado; diagnostic_supply=Insumo diagnóstico"],
[197,"care.form","care.form",["care"],"U","F","tablet=Tableta; capsule=Cápsula; powder=Polvo; granule=Granulado; solution=Solución; suspension=Suspensión; emulsion=Emulsión; drops=Gotas; gel=Gel; cream=Crema; ointment=Ungüento; spray=Atomizador; paste=Pasta; ampoule=Ampolleta; vial=Vial; sachet=Sobre"],
[198,"care.device","care.device",["care"],"U","D","gauze=Gasa; pad=Compresa; roll=Rollo; strip=Tira; syringe=Jeringa; dropper=Gotero; applicator=Aplicador; measuring_cup=Vaso medidor; swab=Hisopo; glove=Guante"]
]
```

## 4. Complete numeric/unit normalization

All numeric candidates below are sellable/searchable false. `N` is a finite scalar; `R` is `{min,max,unit}` with finite endpoints and `min <= max`. Units are exact, case-sensitive closed tokens, no null production unit, no NaN/infinity, no unapproved conversion. Historical null units remain unchanged in the original stored/replay document and in a lossless unsaved adoption buffer, not moved into a separate diagnostic record. Fresh production numeric assignments require the named units below; legacy-family admission remains governed by its existing allowed-unit contract. A production draft may omit an unknown measure; it cannot freshly save a production numeric assignment with missing/null/invalid unit.

`ALL` = all seven fixed family bindings. `DIM` = toy,hygiene,accessory,habitat,care (hygiene/care physical supplies only). `TARGET` = ALL when manufacturer declares target mass. `EQUIP` = accessory,habitat. `COVER` = hygiene,habitat. These abbreviations expand to fixed bindings, not dynamic ownership. Nonlisted family/definition assignments fail structural validation. Applicability within an allowed family follows §5.

| Canonical candidate definition(s), fully enumerated | Type / domain | Exact units | Families / exposure | Source |
| --- | --- | --- | --- | --- |
| `measure.net_mass` | N > 0 | mg,g,kg | ALL / F | V155 |
| `measure.net_volume` | N > 0 | ml,l | ALL / F | V156 |
| `measure.content_count` | positive integer | piece,dose_unit,sheet,roll | ALL / D | **V157**; dose_unit is a declared count, never a dosing recommendation |
| `measure.pack_count` | positive integer interior-unit count | unit | ALL / D | **V158**; positive count technical domain, no stock multiplication |
| `measure.dimensions.external_length`, `measure.dimensions.external_width`, `measure.dimensions.external_height`, `measure.dimensions.external_diameter` | each N > 0 | mm,cm,m | DIM / F | V159; concrete external axes |
| `measure.dimensions.internal_length`, `measure.dimensions.internal_width`, `measure.dimensions.internal_height`, `measure.dimensions.internal_diameter` | each N > 0 | mm,cm,m | DIM / F | V159; concrete internal axes, no substitution for external |
| `measure.fit.neck`, `measure.fit.chest`, `measure.fit.back_length` | each R; no additional lower bound asserted | cm,mm | accessory / F | V160; positive-limit clarification U07, never infer size label |
| `measure.animal_mass` | R, both endpoints > 0 | g,kg | TARGET / F | V161; not species compatibility |
| `measure.capacity.container` | N; physical capacity > 0 technical domain | ml,l | accessory,habitat / F | V162; distinct from net content |
| `measure.capacity.habitat_usable_volume` | N; physical volume > 0 technical domain | ml,l | habitat / F | V162; only explicitly documented usable volume, no dimension calculation |
| `measure.equipment.power` | N finite; no invented bound | W | EQUIP / D | V163; U08 |
| `measure.equipment.voltage` | N finite; no invented bound | V | EQUIP / D | V163; U08 |
| `measure.equipment.frequency` | N finite; no invented bound | Hz | EQUIP / D | V163; U08 |
| `measure.equipment.flow` | N finite; no invented bound | l/h | EQUIP / D | V163; U08 |
| `measure.equipment.temperature` | R, signed, includes zero | °C | EQUIP / D | V163; Celsius, negative endpoints valid; no Kelvin/Fahrenheit conversion |
| `measure.coverage.length` | N; physical length > 0 technical domain | m | COVER / D | V164; separate from dimensional length |
| `measure.coverage.area` | N; physical area > 0 technical domain | m² | COVER / D | V164; never confuse m with m² |

There are 25 numeric candidate definitions. V159–164 broad source rows are provenance groupings, not additional assignable parent measures; no duplicate generic `measure.fit`, `measure.equipment`, etc. Units are closed by concrete definition. Positivity is limited to supported physical magnitudes/counts, not arbitrary power/frequency thresholds or temperature. No universal animal-mass/size mapping. Ranges use one unit for both endpoints; mixed-unit endpoints are malformed, not implicitly converted. V158 pack count is interior count alongside per-unit content when known; it does not authorize fractional sales or convert a 3 × 85 g presentation into 255 inventory units.

`content.kind` is an optional explicit descriptor, not an added D14 minimum. If present, `mass` pairs with net_mass, `volume` with net_volume, `count` with content_count, `length` with coverage.length, `area` with coverage.area, where family permits. Unknown content cannot be replaced by pack_count alone. No contradictory duplicate kind/measures; more than one content magnitude needs separately scoped manufacturer evidence, not a unit conversion. Packaging type/grouping is optional unless it is the documented presentation used to satisfy care's existing minimum.

## 5. Deterministic applicability/publication matrix

This is an executable-in-principle decision table, not opaque rule-name placeholders or a claim of closed business facts. Subtype inputs are existing option codes from §3 (food.format, treat.form, toy.type, hygiene.type, accessory.type, habitat.type, care.type). Facts below are internal evaluation inputs backed by manufacturer source/date; they are not extra selectable vocabularies, public fields, or new unconditional D14 minima. They determine the existing conditions, not variant generation. A subtype alone does not prove all its facts.

### Evaluation algorithm and concrete fact domains

1. Validate structure (types, units, codes, scope, cardinality, references, permissions). Malformed saves fail without mutation/revision change. Structurally valid missing facts/unknown required values save as private incomplete drafts.
2. Resolve each table predicate with three-valued logic. Known true activates the specified minimum; known false permits only the listed NA; unknown means `publicationBlocked` for that condition, never false or automatic NA. Optional unknowns remain optional. Contradictory documented facts block publication until corrected.
3. Require the union of active minima for each currently offered/referenced eligible actual sellable identity. Multi-subtype toys use the union, never one convenient type. Source/date for required claims must cover that exact identity/presentation, not just a sibling or family.
4. Apply care's independent regulatory gate. No invented legal checklist. All gates must pass, including live operational eligibility and concurrency checks; no regulatory/operational substitution. Atomic publication failure preserves Draft and Published; successful descriptive publication never turns visibility on.

Fact domains (not transport/schema approval):

- `contentMagnitude`: one of mass,volume,count,length,area,unknown, with corresponding concrete measure as above. Family bounds apply. For food/treat and care this is required content selection, not an extra mandatory content.kind assignment.
- `consumable`: true/false/unknown; `animalApplied`: true/false/unknown. Required to resolve hygiene's existing conditions only; an unknown in another family's optional context adds no gate.
- `relevantDimensionCodes`: explicit subset of the eight concrete dimension codes in §4; `fitDeterminesChoice`, `capacityDeterminesChoice`: true/false/unknown; `relevantFitCodes`: subset of neck,chest,back_length; `relevantCapacityCodes`: subset of container,habitat_usable_volume restricted by family.
- `electricalApplies`: true/false/unknown; `relevantEquipmentCodes`: subset of power,voltage,frequency,flow,temperature. The source does not say every electrical item needs all five. Manufacturer evidence identifies applicable magnitudes, absence from a label alone is not proof of NA.
- `presentationKind` for care: formulation,device,packaging,unknown; selects care.form, care.device or pack.form respectively as the representation of the **existing** presentation minimum. This is not a fourth care option group.
- `careReview`: unresolved or a specific authorized review covering exact product/presentation, jurisdiction/use, required documentation, required warnings and applicable live recipe controls. It explicitly records which requirements apply, their evidence and their satisfied/NA disposition. No generic boolean "law passed" or editable care option can override controls.

For axis subsets, a known positive relevance determination must name the actual codes, not merely say "relevant"; an empty subset is accepted only with a documented negative relevance finding under a conditional minimum. Unknown subset blocks that minimum. U01–U06 enumerate where the source cannot supply these facts globally. Evidence does not add mandatory optional product claims; it establishes the applicability of already-approved minima.

### Family/subtype → applicable / required / evidence / NA

`E` below means internal source + checked date scoped to the value/fact and sellable. `Content` means the matching supported numeric measure + exact unit. Optional inventory fields remain applicable only when pertinent and documented; none becomes universally mandatory because it appears in §3.

| Family and exhaustive subtype selector | Required existing D14 values | Deterministic conditional values / NA | Evidence and unknown outcome |
| --- | --- | --- | --- |
| food: every one of the 16 food.format options, from kibble through freeze_dried (V176) | animal.target; one food.format; Content | food.role/process/texture optional; food.aquatic only for documented aquatic feeding behavior, otherwise NA allowed by nonaquatic declaration; stage optional with identified animal/cycle | E for recipient and any declared role/process/texture/behavior/stage/composition; unknown recipient/content blocks, never inferred from title |
| treat: every one of 13 treat.form options (V181) | animal.target; one treat.form; Content (mass/volume/count as declared) | treat.base and shared food.process/texture optional; no inferred bone composition/rawhide origin; stage optional | E for recipient, base, process, texture, stage and any composition/claims; unknown required content/unit blocks |
| toy: all 15 toy.type options (V183), individually or explicit multi-selection | nonempty toy.type; animal.target; each code in documented relevantDimensionCodes | Relevant axes chosen per actual design/use, not ball⇒diameter or tunnel⇒all axes. No empty/NA dimension set without a specific reviewed determination that resolves the D14 relevant-dimensions minimum; until then blocked U01. Material/features/size/color optional | E for recipient/features/material and dimension relevance; unknown axis set blocks. Device/electrical claims on a toy do not invent an EQUIP binding outside accessory/habitat |
| hygiene: shampoo,conditioner,wipes,brush,comb,slicker,clipper,nail_clipper,file,towel,pad,diaper,bag,litter,scoop,cleaner (all V185) | hygiene.type always | consumable=true ⇒ hygiene.form + Content; false ⇒ those minima NA. animalApplied=true ⇒ animal.target; false ⇒ recipient minimum NA. Unknown either predicate blocks only its respective condition. litter base only when litter declaration; scent optional and requires explicit label (unspecified ≠ unknown) | E for consumable/animal-applied determinations and required recipient; tools/consumables and animal/environmental variants require actual facts U02/U03; cleaner cannot inherit species. Physical dimensions optional, never extra minima |
| accessory: collar,harness,leash,long_line,tag,muzzle,carrier,stroller,bowl,drinker,fountain,bed,mat,coat,boots,saddle_pad,halter,lead_rope (all V189) | accessory.type | fitDeterminesChoice=true ⇒ all named relevantFitCodes; false ⇒ fit minimum NA. capacityDeterminesChoice=true ⇒ named relevantCapacityCodes (container only); false ⇒ capacity minimum NA. Either unknown or true with unnamed codes blocks U04. Dimensions/equipment/recipient/stage/material/color/closure/features otherwise optional documented fields, not new minima | E for applicability/fit/capacity and any recipient/compatibility/stage/declared features. A collar label does not invent neck interval; a bowl does not supply capacity from appearance |
| habitat: cage,aviary,hutch,pen,terrarium,paludarium,aquarium,pond,coop,shelter,nest,incubator,filter,pump,heater,lamp (all V192) | habitat.type; all documented pertinent dimensions/capacity | Evidence names pertinent relevantDimensionCodes/relevantCapacityCodes (one or both as relevant); an empty set needs documented nonpertinence for equipment-only product. electricalApplies=true ⇒ relevantEquipmentCodes required; false ⇒ electrical minimum NA. Unknown pertinence or electrical applicability/magnitude set blocks U05/U06. Recipient/stage optional, not required for pump | E for pertinence/equipment/compatibility/features; no pump animal or universal reptile compatibility. Thermal range signed °C. Environment/components/substrate optional |
| care: grooming,oral_hygiene,wound_supplies,dressing,bandage,protective_collar,instrument,dosing_device,supplement,medicine,diagnostic_supply (all V196) | care.type; presentation via presentationKind; Content; every required documentation/warning from specific careReview | No blanket NA for presentation/content, even instrument/protective_collar: a documented device/packaging presentation and count may satisfy them. Unknown presentation selection blocks U09; unknown review blocks U10/U11/U12. Recipient/composition optional when documented; no regulatory exemption inferred from care.type | E for presentation/content, claims and review. Required evidence/warnings unresolved ⇒ affected publication blocked, draft valid. Never fabricate law, diagnosis, concentrations, dosage, or replace live recipe controls |

Optional row-specific applicability is also concrete: material only its four bound families and documented material; color/size/porte only their listed families and declaration; pack.form/sale only actual packaging/grouping; content measures only actual content; dimensional fields only physical articles; fit only declared accessory fit; animal_mass only documented target range; capacity only actual container/usable habitat volume; coverage only actual roll/mesh coverage in hygiene/habitat; EQUIP only actual equipment in accessory/habitat; care.device only documented supply format. A nonpertinence fact permits NA for these optional fields; absent evidence remains unknown/unset, not NA or false. Life.stage additionally requires exact declared species/cycle relation; life.aquatic is fish only, never corals/shrimp, and there is no supplied stage vocabulary for mollusks/corals/anemones. Cannot fill that gap using a neighboring life group.

### Matching and counts

Public filters use Published F values only, current tenant/context/category/family/title-description search and live eligibility before pagination. OR within one definition (including both material groups); AND across definitions. All sellable predicates must match one eligible identity, not different siblings. Count unique products. Facet counts omit only that facet's own selected values while keeping other filters and eligibility; active zero-result selections remain removable. D never creates a facet; I never enters public results. Dictionary option count is not a public product count.

### Pending wire v0.3 DRAFT: resolved evaluator semantics, unfinished fact mapping

The relayed v0.3 draft supersedes the v0.2 operator ambiguity. `BindingPolicy.cases.when` uses finite `OptionTest {definitionCode, operator, optionCodes}` tests on same-family, same-subject single/multi bindings, AND between tests. For a known selection set A and nonempty expected set E: `equals_set` means A=E (order-independent); `contains_all` means E is a subset of A; `intersects` means A∩E is nonempty. Missing/unknown/NA never match any operator. Empty expected sets are invalid. Exactly one case must resolve; reject overlapping cases and dependency cycles, not first-match priority. These draft semantics resolve selection matching, not manufacturer facts or compliance.

`publicationCheck` is `always` or `when_asserted`. **Any potentially required case must use always**, even if a particular product resolves to condition-authorized NA. Root selectors have unconditional policies. Evaluation seeds all always bindings plus known/NA optional assertions, then follows only selector dependencies needed to resolve the selected rules. Omitted/unknown optional bindings do not seed evaluation; a pending unused optional rule does not block publication. Reading a dependency resolves its rule, not unrelated mandatory evidence or an assertion of its value. This prevents optional declarations becoming mandatory through global unresolved-policy checks.

| Actual source input / root selector | What option-only cases can express | What is not representable or not yet settled |
| --- | --- | --- |
| food.format=food.format.kibble (V176); treat.form=treat.form.bite (V181) | A case testing a known root option at that same sellable | Content magnitude/evidence validity and manufacturer recipient scope cannot be proven by this test |
| hygiene.type=hygiene.type.wipes or hygiene.type.cleaner (V185) | Known commercial type selection | consumable/animalApplied facts; source row does not settle reusable/animal/environmental uses. Do not create invented consumable or animal-applied option selectors |
| accessory.type=accessory.type.collar or accessory.type.bowl (V189) | Known commercial type selection | Whether fit/capacity determines choice; exact fit interval/capacity relevance; boolean and numeric predicates cannot be OptionTest |
| habitat.type=habitat.type.pump or habitat.type.heater (V192) | Known commercial type selection | Electrical applicability, applicable equipment magnitudes, internal/external dimensions, capacity pertinence and signed thermal range validation |
| care.type=care.type.medicine,care.type.dosing_device (V196); care.form=care.form.solution (V197); care.device=care.device.syringe (V198) | Known selected commercial type and presentation | Required documentation/warnings, jurisdiction/recipe conditions, evidence sufficiency and presentationKind are not option tests. No legal result follows from matching medicine or device |
| toy.type=[toy.type.ball,toy.type.chew] (V183) | equals_set with [ball,chew] matches; contains_all with [ball] matches; intersects with [chew] matches (full canonical codes required) | Independent intersecting ball and chew cases overlap and must be rejected. A singleton equals_set does not cover a multi-selection. Operators now resolve matching, but cannot supply manufacturer-relevant axes or their evidence; do not invent priority, options or generated variants |
| optional toy.feature=toy.feature.rechargeable (V184); optional feature.washable=true (V202); measure.fit.neck range (V160) | Known toy.feature could match an option test at this subject | Absent optional feature must not globally make publication unresolved; boolean/numeric values cannot be tested with OptionTest; numeric evidence/limits need separate validation |

Root selectors are not conditional on themselves or on child values: food.format, treat.form, toy.type, hygiene.type, accessory.type, habitat.type and care.type have unconditional family-level D14 requiredness. Their missing known values block that root minimum, not saving the draft. Never require animal.target to select toy.type while requiring toy.type to activate animal.target; never require care.form to resolve whether care.form is required. Care presentation selection comes from documented product facts, not a self-referential option rule. Family is a product field, not an invented option test.

Optional fields have no global exactly-one-case publication gate merely because an optional selector is absent. An unknown optional food.role, toy.feature, stage, composition or washable value must not introduce mandatory declarations. Required root/conditional D14 gates are evaluated separately using §5; unsupported conditional evaluation is reported unresolved **only for the affected existing minimum**. Option tests alone still cannot implement the full table: source/subject/trust/unknown mapping for the actual manufacturer facts remains unfinished (W01 below). This is an explicit bounded integration gap, not authorization for a new general framework, selector vocabulary, company model or scope adapter. v1 legacy headers are unchanged; scope-adapter engineering is separate.

Concrete multi-toy exercise: the synthetic toy in §7 may explicitly select `[toy.type.ball,toy.type.chew]`, with manufacturer evidence identifying external_diameter for both uses. It still has 4 assignments (6 selected/scalar values), one material definition and one product count; all relevant axes for both uses are required (set union, duplicate diameter once). Another explicit combination `[toy.type.tunnel,toy.type.climbing]` requires the documented union of relevant axes for those uses, not automatically diameter/height based on names. Unknown axes for either use block that existing toy minimum. Operator tests can distinguish these selections; they do not establish the axes.

The following candidate semantic test vectors exercise real V183 options. They are read-only checker inputs, **not** transport policies or new business applicability cases. Option codes must be fully qualified; expected sets are nonempty. Each row is `[state, actualSelection, operator, expectedSelection, matches]`.

```json
{
  "evaluatorFixtureOnly": true,
  "tests": [
    ["known",["toy.type.ball","toy.type.chew"],"equals_set",["toy.type.chew","toy.type.ball"],true],
    ["known",["toy.type.ball","toy.type.chew"],"equals_set",["toy.type.ball"],false],
    ["known",["toy.type.ball","toy.type.chew"],"contains_all",["toy.type.ball"],true],
    ["known",["toy.type.ball","toy.type.chew"],"contains_all",["toy.type.ball","toy.type.tunnel"],false],
    ["known",["toy.type.ball","toy.type.chew"],"intersects",["toy.type.chew","toy.type.tunnel"],true],
    ["known",["toy.type.tunnel","toy.type.climbing"],"equals_set",["toy.type.climbing","toy.type.tunnel"],true],
    ["known",["toy.type.tunnel","toy.type.climbing"],"intersects",["toy.type.ball","toy.type.chew"],false],
    ["unknown",[],"intersects",["toy.type.ball"],false],
    ["NA",[],"contains_all",["toy.type.ball"],false],
    ["omitted",[],"equals_set",["toy.type.ball"],false]
  ]
}
```

| Evaluation exercise | Expected draft-v0.3 result, without added minima |
| --- | --- |
| Multi-toy ball+chew above; material and life.stage omitted; required axes/recipient known and evidenced | toy.type/recipient/relevant-dimension always policies evaluated. Omitted material/stage when_asserted policies do not seed evaluation, even if unused policies are pending. Toy can satisfy descriptive minima without optional declarations |
| Multi-toy tunnel+climbing; material unknown; life.stage unknown | Unknown optional values do not seed evaluation. Documented relevant-axis union remains required independently; unknown axis mapping blocks U01, not because of optional material/stage |
| Toy material known with rubber+plastic, stage omitted | Evaluate material when_asserted policy and only its selected selector dependencies. One material assertion, not two group policies; unrelated pending stage policy does not block |
| Toy stage explicitly NA | Evaluate its when_asserted policy and condition-authorized NA; NA cannot match an OptionTest. Unsupported NA remains unresolved for this assertion; omitted stage would not seed evaluation |
| Two ball/chew intersects cases under the same binding policy | Overlap rejected, even though both tests individually match ball+chew. No priority rule and no new catalog combinations |
| Root toy.type omitted, or root care.type unknown | Unconditional always policy still evaluated; missing required root blocks publication, draft remains valid |
| Policy selecting material depends on toy.type; unrelated optional stage evidence unresolved | Read only the selector dependency needed to resolve material's rule. This does not make stage or its evidence mandatory; cycles are rejected |

Care documentary `resolved` establishes **POLICY readiness only**, not product compliance. Every affected sellable still needs the specific required documents/warnings and live controls to pass; ready policy plus missing/untrusted/wrong-subject evidence still blocks publication. Conversely unrelated pending optional documentary rules do not block an unasserted optional claim. No legal requirement or manufacturer fact is manufactured by an OptionTest.

Candidate wire-aligned range illustration (not final transport approval, synthetic simple identity only):

```json
{
  "candidateOnly": true,
  "known": {"code":"measure.equipment.temperature","owner":"sellable","variantId":null,"state":"known","payload":{"type":"range","min":-5,"max":30,"unit":"°C"},"evidence":{"sourceRef":"synthetic-private-spec","verifiedOn":"2026-01-01"}},
  "unknown": {"code":"measure.equipment.temperature","owner":"sellable","variantId":null,"state":"unknown","evidence":null}
}
```

Unknown/NA have no payload and null evidence in the candidate wire alignment; v0.3 spells the wire states `unknown` and `not_applicable`. The semantic checker shorthand `NA` below is not a wire enum. An internal condition-authorized NA determination is evaluated separately and must not be smuggled into public evidence. These two illustrations are alternatives, never simultaneous assignments. The known unit is the source token `°C`, not inferred `degC`. Private evidence remains internal. `variantId:null` denotes only the synthetic simple case; actual variant payloads must reference supplied real authorized identities, never generated IDs. No company model is proposed here.

## 6. Specific unresolved source cells and evidence to close them

These are local unresolved cells, not a broad request to reopen D14/S4–S6. Technical codes, owner, exposure, cardinality, unit tokens and algorithm above are resolved proposal choices. Unknown business applicability remains explicit. The list does not claim final business/contract approval.

| Cell | Exact missing source fact | Evidence needed / fail-closed effect |
| --- | --- | --- |
| U01 | V183 + §7 toy relevant axes for each actual ball/rope/tug/plush/chew/puzzle/dispenser/wand/teaser/tunnel/wheel/swing/mirror/climbing/floating design | Manufacturer drawing/spec with axis and inner/outer meaning; require named relevant axes; absent determination blocks toy publication, not draft |
| U02 | V185/§7 consumable status for the concrete hygiene presentation, especially wipes/towel/pad/diaper and reusable/disposable forms | Scoped manufacturer presentation/use statement; unknown blocks deciding hygiene.form/Content minimum; no universal subtype guess |
| U03 | V185/§7 animal-applied status for concrete hygiene use, especially wipes/cleaner/towel/pad | Scoped manufacturer intended application; unknown blocks recipient condition; documented environment-only use permits recipient minimum NA |
| U04 | V189/§7 which accessory fit axes/capacity determine selection for each concrete design | Manufacturer sizing/capacity/use specification naming codes, or documented nonpertinence; unknown blocks conditional minimum, no universal collar/bowl mapping |
| U05 | V192/§7 habitat/equipment pertinent dimensions versus container/usable volume, with internal/external distinction | Manufacturer specification naming pertinent axes/capacity or equipment-only nonpertinence; no volume from multiplying dimensions; unknown blocks |
| U06 | V163/192/§7 electrical applicability and applicable magnitudes for concrete equipment | Manufacturer technical sheet identifying required W/V/Hz/flow/temperature and supported NA; unknown blocks affected habitat minimum; accessory equipment stays optional under D14 |
| U07 | V160 fit range has min≤max but no explicit lower-bound policy | Manufacturer measurement semantics plus contract review for any extra bound; retain finite ordered ranges now, no invented universal positive validation |
| U08 | V163 gives units but no universal power/voltage/frequency/flow numerical bounds | Technical specification/domain review for additional bounds; finite typed values valid capture, physically contradictory evidence must be corrected; no arbitrary thresholds or new blanket publication gate |
| U09 | V197/198/§7 care presentation for instruments/protective collars and other non-formulations | Manufacturer identifies device/packaging presentation and count; type alone cannot choose care.form or invent a dose; unknown required presentation/content blocks |
| U10 | §7 care product-specific required documentation | Specific authorized product/presentation/jurisdiction review names required records and satisfaction/NA with provenance; until resolved publication blocked for affected care item, draft valid |
| U11 | V203/§7 care regulatory warnings and public disclosure treatment | Specific review names applicable warnings, evidence and approved disclosure; private warning capture alone insufficient; no public leakage, affected publication blocked |
| U12 | V203/§7 legal/recipe applicability for care | Specific jurisdiction/product/use review and verified live operational control eligibility; no inferred law from medicine/supplement labels, no editable bypass; unresolved affected publication blocked |
| U13 | §3/4 ambiguous common identification and species-specific life cycle | Manufacturer concrete identification for hámster ruso/periquito/tortuga/pez ángel/cangrejo, or actual cycle for broad groups; no automatic alias/expansion; unknown required recipient blocks, optional stage remains unset |
| U14 | V185–186 consumable bag/pad/diaper or other hygiene presentation not represented by the eight hygiene.form options | Manufacturer presentation identification and specific vocabulary/representation review; do not falsely label a bag as wipe or invent a new option. If consumable presentation cannot be represented, preserve draft and block that minimum until resolved |
| W01 (integration, not a new source minimum) | Exact mapping from scoped manufacturer source/date to §5 consumable, animalApplied, fit/capacity relevance, axis/equipment subsets and care evidence; accepted source trust and unknown/conflict handling are unfinished | Agree how each existing conditional minimum reads the correct actual sellable/presentation source, validates trust and maps absent/conflicting evidence to unknown. Until supplied, affected required determinations remain unresolved; unused optional rules do not block. No invented selector options or extra global fact fields |
| W02 (integration) | Per-product documentary compliance check after care policy becomes resolved/ready | Specific linkage between ready policy's requirements and the actual subject's accepted evidence/warnings/live controls; U10–U12 remain product-specific blockers when unsatisfied. Policy readiness alone is never a publish pass |

Unknown optional material/composition/feature text is not a new publication blocker merely because a candidate exists. Conversely evidence missing for a populated required claim is not excused by "all optional." Care unknowns are not an invitation to invent legal facts or reopen already-closed business decisions.

## 7. Representative semantic payload drafts and counts

All examples are **synthetic fixtures**, not observed seed/product data. Names such as `synthetic-simple` and `synthetic-real-variant-A` are nonproduction placeholders, not fabricated existing DB variant IDs. The variant fixture models two explicitly supplied actual identities in the real identity model; it does not generate variants from dictionary combinations. Source refs below are synthetic private evidence, not public media. Assignment counts count definition/value entries, not selected options or nested evidence metadata. Evidence links are shown inline only as semantic annotations; final wire v0.3 representation remains DRAFT.

### Simple product fixture: two materials in one assignment

```json
{
  "fixtureOnly": true,
  "commercialTitle": "Synthetic documented play ball",
  "description": "Synthetic nonclinical manufacturer description",
  "familyCode": "toy",
  "mediaRefs": [],
  "identityModel": "simple",
  "sellables": [{
    "identityPlaceholder": "synthetic-simple",
    "facts": {"relevantDimensionCodes": ["measure.dimensions.external_diameter"], "source": "synthetic-private-spec", "checkedAt": "2026-01-01"},
    "assignments": [
      {"definitionCode": "toy.type", "value": ["toy.type.ball"], "evidence": {"source": "synthetic-private-spec", "checkedAt": "2026-01-01"}},
      {"definitionCode": "animal.target", "value": ["ani.dom.dog"], "evidence": {"source": "synthetic-private-spec", "checkedAt": "2026-01-01"}},
      {"definitionCode": "measure.dimensions.external_diameter", "value": {"number": 6, "unit": "cm"}, "evidence": {"source": "synthetic-private-spec", "checkedAt": "2026-01-01"}},
      {"definitionCode": "material", "value": ["material.base.rubber", "material.rigid.plastic"], "evidence": {"source": "synthetic-private-spec", "checkedAt": "2026-01-01"}}
    ]
  }]
}
```

4 assignments, 5 selected/scalar values, one sellable identity, zero generated variants; material uses two options but one definition. Under the stipulated fixture evidence and live eligibility, diameter + dog matches and counts **1 product**. Rubber OR plastic facet counts **1**, not 2. Unknown toy relevant axes instead would save an incomplete draft and block publish (U01).

### Actual-identity variant model fixture: explicit per-identity values

```json
{
  "fixtureOnly": true,
  "commercialTitle": "Synthetic documented drinking containers",
  "description": "Synthetic nonclinical manufacturer description",
  "familyCode": "accessory",
  "mediaRefs": [],
  "identityModel": "actualVariants",
  "sellables": [
    {
      "identityPlaceholder": "synthetic-real-variant-A",
      "facts": {"fitDeterminesChoice": false, "capacityDeterminesChoice": true, "relevantCapacityCodes": ["measure.capacity.container"], "source": "synthetic-private-spec-A", "checkedAt": "2026-01-01"},
      "assignments": [
        {"definitionCode": "accessory.type", "value": "accessory.type.bowl", "evidence": {"source": "synthetic-private-spec-A", "checkedAt": "2026-01-01"}},
        {"definitionCode": "color.base", "value": ["color.base.blue"], "evidence": {"source": "synthetic-private-spec-A", "checkedAt": "2026-01-01"}},
        {"definitionCode": "measure.capacity.container", "value": {"number": 100, "unit": "ml"}, "evidence": {"source": "synthetic-private-spec-A", "checkedAt": "2026-01-01"}}
      ]
    },
    {
      "identityPlaceholder": "synthetic-real-variant-B",
      "facts": {"fitDeterminesChoice": false, "capacityDeterminesChoice": true, "relevantCapacityCodes": ["measure.capacity.container"], "source": "synthetic-private-spec-B", "checkedAt": "2026-01-01"},
      "assignments": [
        {"definitionCode": "accessory.type", "value": "accessory.type.bowl", "evidence": {"source": "synthetic-private-spec-B", "checkedAt": "2026-01-01"}},
        {"definitionCode": "color.base", "value": ["color.base.red"], "evidence": {"source": "synthetic-private-spec-B", "checkedAt": "2026-01-01"}},
        {"definitionCode": "measure.capacity.container", "value": {"number": 500, "unit": "ml"}, "evidence": {"source": "synthetic-private-spec-B", "checkedAt": "2026-01-01"}}
      ]
    }
  ]
}
```

3 assignments per identity, 6 total, 2 explicit identities, 1 product, 0 generated combinations. Capacity is not net content. With both identities eligible: blue AND 500 ml ⇒ **0 products**; blue AND 100 ml ⇒ **1**; blue OR red ⇒ **1**. Red/500 in an incomplete draft cannot affect Published counts. If only A is live eligible, 500 ml ⇒ **0**. No stock conversion, sibling composition, fallback, or invented lot-per-variant support.

### Other family minimum examples (same semantic assignment notation)

Each row is a separate synthetic simple identity with `mediaRefs: []`, explicit internal evidence for populated claims and relevance facts, and live eligibility assumed only for illustration. These are semantic tuples, not final transport. Counts exclude evidence links as above.

| Fixture | Exact assignments / facts | Outcome / assignment count |
| --- | --- | --- |
| food | animal.target=[ani.dom.dog]; food.format=food.format.kibble; measure.net_mass={number:500,unit:g}; contentMagnitude=mass | Meets descriptive minima with scoped evidence; 3 assignments, one product |
| treat | animal.target=[ani.dom.rabbit]; treat.form=treat.form.bite; measure.content_count={number:12,unit:piece}; contentMagnitude=count | Meets descriptive minima with scoped evidence; 3 assignments, one product; not 12 stock units |
| hygiene consumable animal-applied | hygiene.type=hygiene.type.shampoo; hygiene.form=hygiene.form.liquid; animal.target=[ani.dom.dog]; measure.net_volume={number:100,unit:ml}; consumable=true, animalApplied=true, contentMagnitude=volume | Meets descriptive minima with scoped evidence; 4 assignments, one product |
| hygiene environmental tool | hygiene.type=hygiene.type.scoop; consumable=false, animalApplied=false, each documented | 1 assignment; presentation/content/recipient minima condition-authorized NA; one product, no inferred animal |
| habitat signed thermal | habitat.type=habitat.type.heater; measure.equipment.power={number:25,unit:W}; measure.equipment.voltage={number:120,unit:V}; measure.equipment.temperature={min:-5,max:30,unit:°C}; electricalApplies=true; relevantEquipmentCodes=[power,voltage,temperature]; documented equipment-only dimension/capacity nonpertinence and frequency/flow nonpertinence | 4 assignments; synthetic manufacturer facts only, not safe-use advice; one product if evidence resolves U05/U06, zero public matches while unknown |
| care incomplete review | care.type=care.type.medicine; care.form=care.form.solution; measure.net_volume={number:100,unit:ml}; presentationKind=formulation, contentMagnitude=volume; careReview=unresolved | 3 assignments, valid private incomplete draft, **publication blocked** U10–U12; no published product/count created |
| care non-formulation | care.type=care.type.dosing_device; care.device=care.device.syringe; measure.content_count={number:1,unit:piece}; presentationKind=device, contentMagnitude=count; careReview=unresolved | 3 assignments; presentation/content satisfied, regulatory gate still blocked, no invented medicine exemption |

Negative structural cases: volume with cm, count with null unit, fractional piece count, reversed range, unknown option, another tenant's reference, U field with multiple values or duplicate material assignments are malformed saves, not incomplete drafts. Unknown recipient/source/date for a required claim is structurally incomplete when absent, saves privately and blocks publish; malformed supplied date/reference is rejected on save. Unknown optional stage is not false/NA and does not by itself block publication. Zero Celsius and negative thermal endpoints are valid finite ordered data, not automatic clinical/equipment suitability.

## 8. Structural verification and handoff boundary

Behavioral RED/GREEN tests are not applicable to this documentation-only proposal: it changes no executable behavior. Structural checks below verify the inventory and illustrative vectors, not a production implementation. Structural verification parses the authoritative source and §3 JSON, expands every canonical option code, and compares exact labels, source lines, mappings, bindings and totals. No installer, network, scratch script, production mutation or native review lifecycle is part of this work.

Verification result: 67 rows / 514 unique code-label pairs; animals 22/112, stages 14/72, selectable attributes 31/330; 32 normalized choice definitions; missing=0, extra=0, changed=0. Source SHA-1 remains `9538de694f1125e79e5f2b60e2e4eb49b2e0a05d`. Representative JSON parses; 4 simple and 3+3 variant assignments remain below 200. The checker also exercises 10 v0.3 operator vectors using actual source options and optional evaluation seed states; policy dependency/cycle and per-product compliance implementation tests are outside this documentation task. The reproducible read-only checker below lives inside this one document, not in a scratch script. It reads only the source, this attachment and the authoritative Git blob. Run exactly:

```sh
python3 -c 'from pathlib import Path; t=Path("docs/redesign/production-vocabulary-normalized-proposal.md").read_text(); exec(t.split("```python\n",1)[1].split("\n```",1)[0])'
```

```python
import hashlib, json, re, subprocess
from pathlib import Path
source = Path('docs/redesign/product-vocabularies.md').read_bytes()
blob = '9538de694f1125e79e5f2b60e2e4eb49b2e0a05d'
assert hashlib.sha1(b'blob ' + str(len(source)).encode() + b'\0' + source).hexdigest() == blob
assert subprocess.check_output(['git', 'cat-file', 'blob', blob]) == source
text = Path('docs/redesign/production-vocabulary-normalized-proposal.md').read_text()
blocks = [json.loads(x) for x in re.findall(r'```json\n(.*?)\n```', text, re.S)]
rows = blocks[0]
lines = source.decode().splitlines()
expected, actual, source_rows = {}, {}, {}
for line_no, line in enumerate(lines, 1):
    if not line.startswith('| `'):
        continue
    cells = [c.strip() for c in line.split('|')[1:-1]]
    group, pairs = cells[0].strip('`'), cells[-1]
    if not re.fullmatch(r'[a-z_]+=[^;]+(?:; [a-z_]+=[^;]+)*', pairs):
        continue
    source_rows[group] = (line_no, pairs)
    for pair in pairs.split('; '):
        key, label = pair.split('=', 1)
        expected[group + '.' + key] = label
families = ['food', 'treat', 'toy', 'hygiene', 'accessory', 'habitat', 'care']
for line_no, group, definition, fs, typ, exposure, pairs in rows:
    assert source_rows[group] == (line_no, pairs), group
    mapped = ('animal.target' if group.startswith('ani.') else
              'life.stage' if group.startswith('life.') else
              'material' if group.startswith('material.') else group)
    assert definition == mapped
    assert typ in ['U', 'M'] and exposure in ['F', 'D']
    assert fs and len(fs) == len(set(fs)) and set(fs) <= set(families)
    if group.startswith(('ani.', 'life.')):
        assert fs == families and typ == 'M' and exposure == 'F'
    else:
        descriptor = lines[line_no - 1].split('|')[2].strip().split(' · ')
        assert typ == descriptor[1] and exposure == descriptor[3]
        assert fs == (families if descriptor[4] == 'todas' else descriptor[4].split('/'))
    for pair in pairs.split('; '):
        key, label = pair.split('=', 1)
        code = group + '.' + key
        assert code not in actual
        actual[code] = label
assert len(rows) == len(source_rows) == 67
assert set(source_rows) == {r[1] for r in rows}
assert actual == expected and len(actual) == 514
for prefix, row_count, option_count in [('ani.', 22, 112), ('life.', 14, 72), ('', 31, 330)]:
    selected = ([r for r in rows if r[1].startswith(prefix)] if prefix else
                [r for r in rows if not r[1].startswith(('ani.', 'life.'))])
    assert len(selected) == row_count
    assert sum(len(r[-1].split('; ')) for r in selected) == option_count
    print(prefix or 'attributes', row_count, option_count)
assert len({r[2] for r in rows}) == 32
fixtures = [b for b in blocks[1:] if 'sellables' in b]
assert [[len(s['assignments']) for s in b['sellables']] for b in fixtures] == [[4], [3, 3]]
for fixture in fixtures:
    assert fixture['fixtureOnly'] and fixture['mediaRefs'] == []
    for sellable in fixture['sellables']:
        assignments = sellable['assignments']
        assert len(assignments) <= 200
        assert len({a['definitionCode'] for a in assignments}) == len(assignments)
        for assignment in assignments:
            code, value = assignment['definitionCode'], assignment['value']
            if isinstance(value, str):
                assert value in actual
            if isinstance(value, list):
                for option in value:
                    assert option in actual
                    assert any(r[2] == code and option.startswith(r[1] + '.') for r in rows)
vectors = [b for b in blocks if isinstance(b, dict) and b.get('evaluatorFixtureOnly')]
assert len(vectors) == 1 and len(vectors[0]['tests']) == 10
for state, selection, operator, expected_selection, expected_match in vectors[0]['tests']:
    assert expected_selection and len(expected_selection) == len(set(expected_selection))
    assert all(option in actual for option in selection + expected_selection)
    selected_set, expected_set = set(selection), set(expected_selection)
    comparison = {'equals_set': selected_set == expected_set,
                  'contains_all': expected_set <= selected_set,
                  'intersects': bool(selected_set & expected_set)}[operator]
    assert (state == 'known' and comparison) == expected_match
# Scope of optional evaluation only; this is not a production policy evaluator.
for optional_state, expected_seeds in [
    ('omitted', {'toy.type'}), ('unknown', {'toy.type'}),
    ('known', {'toy.type', 'material'}), ('NA', {'toy.type', 'material'})
]:
    bindings = [('toy.type', 'always', 'unknown'),
                ('material', 'when_asserted', optional_state),
                ('life.stage', 'when_asserted', 'omitted')]
    seeds = {code for code, check, state in bindings
             if check == 'always' or state in ['known', 'NA']}
    assert seeds == expected_seeds
print('PASS: authoritative blob; 67/514; missing=0 extra=0 changed=0; 32 choice definitions; bindings; JSON; fixture counts 4 and 3+3; 10 v0.3 operator vectors; optional seed states')
```

Wire v0.3 DRAFT must reference this updated attachment and its returned hash. It must not pretend summary counts or opaque rule strings close U01–U14 or the option-only evaluator gaps. Parent owns review, contract assessment and any later authorization. This artifact is neither final contract/business approval nor permission to apply a manifest.
