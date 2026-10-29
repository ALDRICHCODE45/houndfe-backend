// Symbolic initial defaults: inventory/provenance and construction live here.
// Normative rows and membership are owned by the pure domain catalog.
import {
  FAMILY_CODES,
  CHOICES,
  NUMBERS,
  OTHER,
  ProductionFamily,
  RuleId,
  ProductionDefinitionCode,
  ChoiceCode,
} from '../src/catalog-editorial/domain/editorial-production-vocabulary-catalog';
export type {
  ProductionFamily,
  RuleId,
  ProductionDefinitionCode,
} from '../src/catalog-editorial/domain/editorial-production-vocabulary-catalog';
export type ProductionValueType =
  | 'single'
  | 'multi'
  | 'number'
  | 'range'
  | 'text'
  | 'boolean';
type ExposureKey = 'F' | 'D' | 'I';

type Option = {
  code: string;
  label: string;
  sortOrder: number;
  archived: false;
};
type Group = { code: string; label: string; optionCodes: string[] };
type Alias = { label: string; optionCode: string };
type DefinitionBase = { code: ProductionDefinitionCode; label: string };
export type ProductionDefinition = DefinitionBase &
  (
    | {
        type: 'single' | 'multi';
        options: Option[];
        groups: Group[];
        aliases: Alias[];
      }
    | { type: 'text' | 'boolean' }
    | {
        type: 'number' | 'range';
        units: { code: string; label: string; sortOrder: number }[];
        numericPolicy: {
          status: 'resolved';
          magnitude: ProductionDefinitionCode;
          integer: boolean;
          lower: 0 | null;
          lowerInclusive: false;
          upper: null;
          upperInclusive: false;
        };
      }
  );
export type ProductionBinding = {
  definitionCode: ProductionDefinitionCode;
  owner: 'sellable';
  sortOrder: number;
  exposure: 'FACET' | 'DETAIL' | 'INTERNAL';
  searchable: false;
  publicationCheck: 'always' | 'when_asserted';
  policy: {
    route: 'fact_rule';
    rule: {
      family: ProductionFamily;
      ruleId: RuleId;
      parameter: ProductionDefinitionCode;
    };
  };
};
export type ProductionVocabularyManifest = {
  semanticsVersion: 'editorial-production-1';
  provenance: {
    source: { blob: string; sha256: string };
    normalized: { blob: string; sha256: string };
    overlay: { authority: 'S7'; options: { code: string; label: string }[] };
  };
  families: {
    code: ProductionFamily;
    label: string;
    minimumContractVersion: 2;
    bindings: ProductionBinding[];
  }[];
  definitions: ProductionDefinition[];
};

// Immutable normalized rows, with exact source captions (source column 2).
// Each row is definition, group, caption, key=label pairs; groups are NOT options.
// prettier-ignore
const INVENTORY: readonly (readonly [ChoiceCode, string, string, string])[] = [
  ['animal.target', 'ani.dom', 'Compañía doméstica', 'dog=Perro; cat=Gato; rabbit=Conejo doméstico; ferret=Hurón doméstico; guinea_pig=Cobaya'],
  ['animal.target', 'ani.small', 'Pequeños mamíferos identificados', 'syrian_hamster=Hámster sirio; roborovski=Hámster de Roborovski; degu=Degú; fancy_rat=Rata doméstica; house_mouse=Ratón doméstico'],
  ['animal.target', 'ani.small_group', 'Pequeños mamíferos: grupos', 'dwarf_hamsters=Hámsteres enanos; gerbils=Jerbos; hedgehogs=Erizos; sugar_gliders=Petauros; dormice=Lirones; chinchillas=Chinchillas domésticas'],
  ['animal.target', 'ani.bird_pet', 'Aves de compañía identificadas', 'canary=Canario doméstico; budgerigar=Periquito australiano; cockatiel=Ninfa; zebra_finch=Diamante mandarín; java_sparrow=Gorrión de Java'],
  ['animal.target', 'ani.bird_group', 'Aves ornamentales: grupos', 'lovebirds=Agapornis; parrots=Loros; macaws=Guacamayas; cockatoos=Cacatúas; conures=Cotorras y conuros; finches=Pinzones ornamentales'],
  ['animal.target', 'ani.poultry', 'Aves de corral identificadas', 'chicken=Gallina doméstica; turkey=Pavo doméstico; guinea_fowl=Gallina de Guinea; pigeon=Paloma doméstica'],
  ['animal.target', 'ani.poultry_group', 'Aves de corral: grupos', 'ducks=Patos domésticos; geese=Gansos domésticos; quail=Codornices; pheasants=Faisanes; peafowl=Pavos reales; ratites=Ratites de granja'],
  ['animal.target', 'ani.lizard', 'Lagartos identificados', 'leopard_gecko=Gecko leopardo; crested_gecko=Gecko crestado; green_iguana=Iguana verde'],
  ['animal.target', 'ani.lizard_group', 'Lagartos: grupos', 'geckos=Geckos; chameleons=Camaleones; anoles=Anolis; skinks=Escíncidos; monitors=Varanos; bearded_dragons=Dragones barbudos'],
  ['animal.target', 'ani.snake', 'Serpientes identificadas', 'corn_snake=Serpiente del maíz; ball_python=Pitón bola'],
  ['animal.target', 'ani.reptile_group', 'Otros grupos de reptiles', 'boas=Boas; pythons=Pitones; kingsnakes=Serpientes rey; tortoises=Tortugas terrestres; aquatic_turtles=Tortugas acuáticas; semiaquatic_turtles=Tortugas semiacuáticas'],
  ['animal.target', 'ani.amphibian', 'Anfibios identificados', 'axolotl=Ajolote mexicano; african_clawed_frog=Rana de uñas africana'],
  ['animal.target', 'ani.amphibian_group', 'Anfibios: grupos', 'frogs=Ranas; toads=Sapos; tree_frogs=Ranas arborícolas; newts=Tritones; salamanders=Salamandras'],
  ['animal.target', 'ani.freshwater', 'Acuario dulce: identificaciones comunes', 'goldfish=Pez dorado; guppy=Guppy; neon_tetra=Tetra neón; cardinal_tetra=Tetra cardenal; zebrafish=Pez cebra'],
  ['animal.target', 'ani.freshwater_group', 'Acuario dulce: grupos', 'bettas=Bettas; mollies=Mollys; platies=Platys; swordtails=Colas de espada; corydoras=Corydoras; plecos=Plecos; cichlids=Cíclidos; gouramis=Guramis; discus=Peces disco'],
  ['animal.target', 'ani.aquatic_other', 'Estanque y aguas salobres: grupos', 'koi=Carpas koi; pond_fish=Peces de estanque; brackish_fish=Peces de agua salobre'],
  ['animal.target', 'ani.marine', 'Acuario marino: peces por grupo', 'clownfish=Peces payaso; surgeonfish=Peces cirujano; marine_angelfish=Peces ángel marinos; gobies=Gobios marinos; blennies=Blénidos marinos; damselfish=Damiselas; wrasses=Lábridos; butterflyfish=Peces mariposa'],
  ['animal.target', 'ani.aquatic_invert', 'Invertebrados de acuario: grupos', 'freshwater_shrimp=Camarones de agua dulce; freshwater_snails=Caracoles de agua dulce; crayfish=Cangrejos de río; marine_shrimp=Camarones marinos; hermit_crabs=Cangrejos ermitaños marinos; corals=Corales; anemones=Anémonas marinas; marine_snails=Caracoles marinos'],
  ['animal.target', 'ani.equine', 'Équidos identificados', 'horse=Caballo; donkey=Asno'],
  ['animal.target', 'ani.equine_group', 'Équidos: grupo comercial', 'mules=Mulas y burdéganos'],
  ['animal.target', 'ani.farm', 'Mamíferos de granja identificados', 'cattle=Bovino doméstico; sheep=Ovino doméstico; goat=Caprino doméstico; pig=Cerdo doméstico; water_buffalo=Búfalo de agua doméstico; llama=Llama; alpaca=Alpaca'],
  ['animal.target', 'ani.terrestrial_invert', 'Invertebrados terrestres: grupos', 'tarantulas=Tarántulas; scorpions=Escorpiones; mantises=Mantis; stick_insects=Insectos palo; beetles=Escarabajos; isopods=Isópodos terrestres; land_snails=Caracoles terrestres; bees=Abejas'],
  ['life.stage', 'life.dog', 'Perro', 'nursing=Lactante; puppy=Cachorro; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia'],
  ['life.stage', 'life.cat', 'Gato', 'nursing=Lactante; kitten=Gatito; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia'],
  ['life.stage', 'life.small', 'Pequeños mamíferos; validar especie', 'nursing=Lactante; juvenile=Juvenil; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia'],
  ['life.stage', 'life.bird', 'Aves ornamentales', 'chick=Polluelo; fledgling=Volantón; juvenile=Juvenil; adult=Adulto; breeding=Reproducción; laying=Puesta'],
  ['life.stage', 'life.poultry', 'Aves de corral; validar tipo de ave', 'starter=Inicio; grower=Crecimiento; developer=Desarrollo; finisher=Finalización; layer=Postura; breeder=Reproductor'],
  ['life.stage', 'life.reptile', 'Reptiles', 'hatchling=Recién eclosionado; juvenile=Juvenil; adult=Adulto; breeding=Reproducción'],
  ['life.stage', 'life.amphibian', 'Anfibios según ciclo específico', 'larval=Larvaria; metamorph=Metamorfosis; juvenile=Juvenil; adult=Adulto'],
  ['life.stage', 'life.aquatic', 'Peces; no trasladar a corales o camarones', 'larval=Larvaria; fry=Alevín; juvenile=Juvenil; adult=Adulto; broodstock=Reproductor'],
  ['life.stage', 'life.equine', 'Équidos', 'nursing=Lactante; foal=Cría; growing=Crecimiento; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia'],
  ['life.stage', 'life.farm', 'Mamíferos de granja; validar animal', 'nursing=Lactante; preweaning=Pre-destete; postweaning=Post-destete; growing=Crecimiento; finishing=Finalización; adult=Adulto; gestation=Gestación; lactation=Lactancia'],
  ['life.stage', 'life.crustacean', 'Crustáceos; validar ciclo de la especie', 'larval=Larvaria; postlarval=Postlarvaria; juvenile=Juvenil; adult=Adulto'],
  ['life.stage', 'life.insect_complete', 'Insectos con metamorfosis completa', 'egg=Huevo; larva=Larva; pupa=Pupa; adult=Adulto'],
  ['life.stage', 'life.insect_incomplete', 'Insectos con metamorfosis incompleta', 'egg=Huevo; nymph=Ninfa; adult=Adulto'],
  ['life.stage', 'life.arachnid', 'Arácnidos; validar ciclo de la especie', 'juvenile=Juvenil; subadult=Subadulto; adult=Adulto'],
  ['pack.form', 'pack.form', 'Envase', 'bag=Bolsa; sack=Saco; can=Lata; pouch=Sobre; tray=Bandeja; jar=Frasco; bottle=Botella; tube=Tubo; box=Caja; blister=Blíster; bucket=Cubeta; tub=Bote; wrap=Envoltura; bulk=Granel'],
  ['pack.sale', 'pack.sale', 'Agrupación vendible', 'single=Individual; multipack=Paquete múltiple; kit=Kit; pair=Par; case=Caja comercial; display=Exhibidor; refill=Recarga'],
  ['content.kind', 'content.kind', 'Magnitud del contenido', 'mass=Masa; volume=Volumen; count=Conteo; length=Longitud; area=Superficie'],
  ['material', 'material.base', 'Materiales declarados', 'rubber=Caucho; latex=Látex; silicone=Silicona; tpr=Elastómero termoplástico; nylon=Poliamida; polyester=Poliéster; cotton=Algodón; hemp=Cáñamo; jute=Yute; sisal=Sisal; rope=Cuerda de fibra no especificada; fleece=Tejido polar; felt=Fieltro; plush=Tejido de peluche'],
  ['material', 'material.rigid', 'Materiales rígidos/minerales', 'stainless=Acero inoxidable; steel=Acero; aluminium=Aluminio; plastic=Plástico no especificado; polypropylene=Polipropileno; polyethylene=Polietileno; abs=ABS; pvc=PVC; acrylic=Acrílico; glass=Vidrio; ceramic=Cerámica; wood=Madera; bamboo=Bambú; cardboard=Cartón; paper=Papel; stone=Piedra'],
  ['color.base', 'color.base', 'Color comercial', 'black=Negro; white=Blanco; grey=Gris; brown=Café; beige=Beige; red=Rojo; orange=Naranja; yellow=Amarillo; green=Verde; blue=Azul; purple=Morado; pink=Rosa; transparent=Transparente; multicolor=Multicolor; assorted=Surtido'],
  ['size.label', 'size.label', 'Talla comercial', 'xxs=XXS; xs=XS; s=S; m=M; l=L; xl=XL; xxl=XXL; xxxl=XXXL; adjustable=Ajustable; one_size=Talla única'],
  ['size.animal', 'size.animal', 'Porte declarado', 'miniature=Miniatura; small=Pequeño; medium=Mediano; large=Grande; giant=Gigante'],
  ['food.format', 'food.format', 'Formato', 'kibble=Croquetas; pellet=Pellets; flake=Hojuelas; granule=Gránulos; stick=Barritas; wafer=Discos alimenticios; pate=Paté; chunks=Trozos; mousse=Mousse; broth=Caldo; powder=Polvo; seed_mix=Mezcla de semillas; hay=Heno; forage=Forraje; frozen=Congelado; freeze_dried=Liofilizado'],
  ['food.role', 'food.role', 'Función alimentaria declarada', 'complete=Alimento completo; complementary=Alimento complementario; supplemental=Suplemento alimenticio; milk_replacer=Sustituto lácteo; forage=Forraje; breeding_feed=Alimento para reproductores'],
  ['food.process', 'food.process', 'Procesamiento declarado', 'extruded=Extruido; baked=Horneado; dehydrated=Deshidratado; freeze_dried=Liofilizado; canned=Enlatado; frozen=Congelado; air_dried=Secado al aire; cold_pressed=Prensado en frío'],
  ['food.texture', 'food.texture', 'Textura', 'dry=Seca; moist=Húmeda; semimoist=Semihúmeda; soft=Blanda; crunchy=Crujiente; liquid=Líquida; gel=Gel'],
  ['food.aquatic', 'food.aquatic', 'Comportamiento acuático declarado', 'floating=Flotante; slow_sinking=Hundimiento lento; sinking=De fondo; suspended=En suspensión'],
  ['treat.form', 'treat.form', 'Forma de premio/carnaza', 'bite=Bocaditos; biscuit=Galleta; strip=Tira; cube=Cubo; stick=Palito; roll=Rollo; ring=Aro; knot=Nudo; braid=Trenza; bone_shape=Forma de hueso; lickable=Premio para lamer; paste=Pasta; dried_piece=Pieza deshidratada'],
  ['treat.base', 'treat.base', 'Base declarada', 'rawhide=Carnaza de piel; meat=Carne; fish=Pescado; vegetable=Vegetal; cereal=Cereal; dairy=Lácteo; insect=Insectos'],
  ['toy.type', 'toy.type', 'Tipo de juego', 'ball=Pelota; rope=Cuerda de juego; tug=Tirador; plush=Peluche; chew=Mordedor; puzzle=Rompecabezas; dispenser=Dispensador; wand=Varita; teaser=Señuelo; tunnel=Túnel; wheel=Rueda; swing=Columpio; mirror=Espejo; climbing=Trepa; floating=Juguete flotante'],
  ['toy.feature', 'toy.feature', 'Característica declarada', 'squeaker=Con sonido al presionar; crinkle=Con material crujiente; bell=Con cascabel; catnip=Contiene catnip; refillable=Rellenable; treat_dispensing=Dispensa premios; suction=Con ventosa; interactive=Interactivo; battery=Funciona con pilas; rechargeable=Recargable'],
  ['hygiene.type', 'hygiene.type', 'Tipo de higiene', 'shampoo=Champú; conditioner=Acondicionador; wipes=Toallitas; brush=Cepillo; comb=Peine; slicker=Carda; clipper=Cortadora; nail_clipper=Cortaúñas; file=Lima; towel=Toalla; pad=Tapete absorbente; diaper=Pañal; bag=Bolsa para residuos; litter=Arena sanitaria; scoop=Pala sanitaria; cleaner=Limpiador de entorno'],
  ['hygiene.form', 'hygiene.form', 'Presentación de higiene', 'liquid=Líquido; foam=Espuma; spray=Atomizador; gel=Gel; powder=Polvo; bar=Barra; wipe=Toallita; granule=Granulado'],
  ['hygiene.litter', 'hygiene.litter', 'Base de lecho sanitario', 'bentonite=Bentonita; silica=Sílice; paper=Papel; wood=Madera; corn=Maíz; tofu=Derivado de soya; walnut=Cáscara de nuez; grass=Fibras de pasto'],
  ['hygiene.scent', 'hygiene.scent', 'Fragancia declarada', 'unscented=Sin fragancia añadida; scented=Con fragancia; unspecified=Fragancia no especificada por fabricante'],
  ['accessory.type', 'accessory.type', 'Tipo de accesorio', 'collar=Collar; harness=Arnés; leash=Correa; long_line=Línea larga; tag=Placa; muzzle=Bozal; carrier=Transportadora; stroller=Carriola; bowl=Comedero; drinker=Bebedero; fountain=Fuente; bed=Cama; mat=Colchoneta; coat=Abrigo; boots=Botas; saddle_pad=Mantilla; halter=Cabezada de cuadra; lead_rope=Ramal'],
  ['accessory.closure', 'accessory.closure', 'Cierre', 'buckle=Hebilla; quick_release=Broche de liberación rápida; hook_loop=Cierre de gancho y bucle; zipper=Cremallera; snap=Broche a presión; tie=Amarre; carabiner=Mosquetón; screw=Tornillo'],
  ['accessory.feature', 'accessory.feature', 'Característica declarada', 'adjustable=Ajustable; reflective=Reflectante; padded=Acolchado; foldable=Plegable; removable_cover=Funda desmontable; nonslip=Base antideslizante; elevated=Elevado; double=Doble; portable=Portátil; wall_mount=Montaje en pared'],
  ['habitat.type', 'habitat.type', 'Tipo de hábitat/equipo', 'cage=Jaula; aviary=Aviario; hutch=Conejera; pen=Corral; terrarium=Terrario; paludarium=Paludario; aquarium=Acuario; pond=Estanque; coop=Gallinero; shelter=Refugio; nest=Nido; incubator=Incubadora; filter=Filtro; pump=Bomba; heater=Calentador; lamp=Lámpara'],
  ['habitat.environment', 'habitat.environment', 'Entorno declarado', 'terrestrial=Terrestre; arboreal=Arborícola; semiaquatic=Semiacuático; freshwater=Agua dulce; brackish=Agua salobre; marine=Marino; indoor=Interior; outdoor=Exterior'],
  ['habitat.substrate', 'habitat.substrate', 'Base de sustrato', 'coconut=Fibra de coco; bark=Corteza; soil=Tierra; sand=Arena; gravel=Grava; clay=Arcilla; paper=Papel; hemp=Cáñamo; straw=Paja; wood_shavings=Viruta de madera; moss=Musgo; mineral_mix=Mezcla mineral'],
  ['habitat.component', 'habitat.component', 'Componente/equipamiento', 'perch=Percha; platform=Plataforma; hide=Escondite; ramp=Rampa; feeder=Alimentador; dripper=Gotero; misting=Nebulización; thermostat=Termostato; thermometer=Termómetro; hygrometer=Higrómetro; timer=Temporizador; aeration=Aireación; lighting=Iluminación; filtration=Filtración'],
  ['care.type', 'care.type', 'Tipo comercial de cuidado', 'grooming=Cuidado externo; oral_hygiene=Higiene oral; wound_supplies=Material de curación; dressing=Apósitos; bandage=Vendajes; protective_collar=Collar protector; instrument=Instrumental; dosing_device=Dispositivo de administración; supplement=Suplemento declarado; medicine=Medicamento declarado; diagnostic_supply=Insumo diagnóstico'],
  ['care.form', 'care.form', 'Presentación declarada', 'tablet=Tableta; capsule=Cápsula; powder=Polvo; granule=Granulado; solution=Solución; suspension=Suspensión; emulsion=Emulsión; drops=Gotas; gel=Gel; cream=Crema; ointment=Ungüento; spray=Atomizador; paste=Pasta; ampoule=Ampolleta; vial=Vial; sachet=Sobre'],
  ['care.device', 'care.device', 'Formato de insumo', 'gauze=Gasa; pad=Compresa; roll=Rollo; strip=Tira; syringe=Jeringa; dropper=Gotero; applicator=Aplicador; measuring_cup=Vaso medidor; swab=Hisopo; glove=Guante'],
];
// prettier-ignore
const OVERLAY = [['hygiene.form.bag', 'Bolsa'], ['hygiene.form.pad', 'Tapete absorbente'], ['hygiene.form.diaper', 'Pañal']] as const;
// prettier-ignore
const ALIASES = [
  ['cobaya', 'ani.dom.guinea_pig'], ['cuyo', 'ani.dom.guinea_pig'],
  ['cuy', 'ani.dom.guinea_pig'], ['conejillo de Indias', 'ani.dom.guinea_pig'],
  ['ninfa', 'ani.bird_pet.cockatiel'], ['carolina', 'ani.bird_pet.cockatiel'],
  ['asno', 'ani.equine.donkey'], ['burro', 'ani.equine.donkey'],
] as const;

function expandFamilies(token: string): ProductionFamily[] {
  return token === 'ALL'
    ? [...FAMILY_CODES]
    : (token.split(',') as ProductionFamily[]);
}
function publicationCheck(
  family: ProductionFamily,
  rule: RuleId,
): ProductionBinding['publicationCheck'] {
  const always: RuleId[] = [
    'required',
    'animal',
    'form',
    'fit',
    'capacity',
    'space',
    'presentation',
    'dimensions',
    'equipment',
  ];
  return always.includes(rule) ||
    (rule === 'content' &&
      ['food', 'treat', 'hygiene', 'care'].includes(family))
    ? 'always'
    : 'when_asserted';
}

/** Build fresh symbolic initial defaults. No evaluation, ID allocation or apply. */
export function buildProductionVocabularyManifest(): ProductionVocabularyManifest {
  const definitions: ProductionDefinition[] = [];
  const families: ProductionVocabularyManifest['families'] = FAMILY_CODES.map(
    (code) => ({ code, label: code, minimumContractVersion: 2, bindings: [] }),
  );
  const add = (
    definition: ProductionDefinition,
    exposure: ExposureKey,
    spec: string,
  ) => {
    const sortOrder = definitions.length;
    definitions.push(definition);
    for (const token of spec.split(',')) {
      const [familyToken, ruleToken] = token.split(':');
      const ruleId = ruleToken as RuleId;
      for (const family of expandFamilies(familyToken)) {
        families
          .find((f) => f.code === family)!
          .bindings.push({
            definitionCode: definition.code,
            owner: 'sellable',
            sortOrder,
            exposure: ({ F: 'FACET', D: 'DETAIL', I: 'INTERNAL' } as const)[
              exposure
            ],
            searchable: false,
            publicationCheck: publicationCheck(family, ruleId),
            policy: {
              route: 'fact_rule',
              rule: { family, ruleId, parameter: definition.code },
            },
          });
      }
    }
  };
  for (const [code, type, exposure, spec] of CHOICES) {
    const options: Option[] = [];
    const groups: Group[] = [];
    for (const [definitionCode, group, label, pairs] of INVENTORY) {
      if (definitionCode !== code) continue;
      const optionCodes = pairs.split('; ').map((pair) => {
        const separator = pair.indexOf('=');
        const optionCode = `${group}.${pair.slice(0, separator)}`;
        options.push({
          code: optionCode,
          label: pair.slice(separator + 1),
          sortOrder: options.length,
          archived: false,
        });
        return optionCode;
      });
      groups.push({ code: group, label, optionCodes });
    }
    if (code === 'hygiene.form')
      for (const [optionCode, label] of OVERLAY) {
        options.push({
          code: optionCode,
          label,
          sortOrder: options.length,
          archived: false,
        });
        groups[0].optionCodes.push(optionCode);
      }
    const aliases =
      code === 'animal.target'
        ? ALIASES.map(([label, optionCode]) => ({ label, optionCode }))
        : [];
    add({ code, label: code, type, options, groups, aliases }, exposure, spec);
  }
  for (const [code, type, units, exposure, domain, spec] of NUMBERS) {
    add(
      {
        code,
        label: code,
        type,
        units: units
          .split(',')
          .map((unit, sortOrder) => ({ code: unit, label: unit, sortOrder })),
        numericPolicy: {
          status: 'resolved',
          magnitude: code,
          integer: domain === 'I',
          lower: domain === 'F' ? null : 0,
          lowerInclusive: false,
          upper: null,
          upperInclusive: false,
        },
      },
      exposure,
      spec,
    );
  }
  for (const [code, type, familySpec, exposure] of OTHER) {
    add(
      { code, label: code, type },
      exposure,
      expandFamilies(familySpec)
        .map((f) => `${f}:optional`)
        .join(','),
    );
  }
  return {
    semanticsVersion: 'editorial-production-1',
    families,
    definitions,
    provenance: {
      source: {
        blob: '9538de694f1125e79e5f2b60e2e4eb49b2e0a05d',
        sha256:
          '2ce7b92a4866c3693a7a373fe0e1cbc7199b67e0c3a1e66725534fed9c8a8205',
      },
      normalized: {
        blob: 'fd89f5a29edb8015f4a361888cbcddfd6098b173',
        sha256:
          '1dc079543c8607c8d984f548ec22d21c4092f342577c7c2e14dba7c5467488a9',
      },
      overlay: {
        authority: 'S7',
        options: OVERLAY.map(([code, label]) => ({ code, label })),
      },
    },
  };
}
