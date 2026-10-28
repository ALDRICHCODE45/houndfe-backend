# Vocabularios iniciales para un catálogo amplio de animales

**Propuesta para validar C1/G1; no es una semilla de producción ni autorización de implementación.** Desarrolla D11/D12 y aplica D13/D14 de la [estrategia de catálogo](catalog-product-strategy.md); acompaña la [hoja de ruta](implementation-roadmap.md) y el [contrato descriptivo propuesto](product-contract-proposal.md). Incluye opciones listas para revisión, no listas vacías que el cliente deba construir.
El híbrido está aprobado conceptualmente: núcleo operativo estable + atributos tipados por familia + variantes vendibles. Los mínimos de publicación por familia están aprobados en D14 (§7). Códigos y agrupaciones siguen propuestos, no son identificadores canónicos aprobados.

## 1. Ruta de revisión y límites

1. Revisar amplitud animal (§3), después atributos comunes y por familia (§4–6).
2. Especificar la aplicabilidad técnica de los mínimos aprobados (§7); validar administración (§8) y ejemplos de aceptación futura (§9).
3. Especificar y verificar el ámbito empresarial D17 y los contratos con los agentes frontend/backend; no deducir tablas, endpoints ni permisos nuevos de este documento.

- Las categorías actuales son planas y las opciones/valores de variante simples: esta capa sería aditiva, no una conversión ya disponible.
- No cambia SKU, precios, inventario, unidad de venta, receta, lotes ni caducidad. No habilita cantidades fraccionarias ni conversiones caja/pieza.
- Clasificar un animal **no acredita compatibilidad de ningún producto**; esta exige documentación del fabricante para el producto/presentación concretos. Tampoco hereda compatibilidad desde un grupo.
- No hay recomendaciones médicas, dosis, diagnósticos, marcas inventadas ni afirmaciones sobre disponibilidad legal de especies. Verificar requisitos locales aparte.
- Sin investigación externa: usamos nombres comunes y agrupaciones comerciales explícitas; no afirmamos taxonomía científica exhaustiva. Homónimos y nombres regionales quedan sujetos a revisión.

## 2. Convenciones para leer y cargar la propuesta

| Convención | Significado y regla |
| --- | --- |
| `prefijo` + `clave=Etiqueta` | Cada opción propone el código canónico inmutable `prefijo.clave`; por ejemplo `ani.dom.dog`. Son sugerencias aún no aprobadas. No usar la etiqueta como identidad. |
| `U` / `M` / `N` / `B` / `T` | Tipos propuestos `singleChoice` / `multiChoice` / `number` / `bool` / `text`: selección única/múltiple, número, booleano explícito y texto documentado. |
| `P` / `V` / `P→V` | P = ámbito común `product`; V = identidad vendible `sellable` (producto simple o variante real). P→V se conserva como marca de origen del inventario; la matriz inicial de esta sección propone su resolución explícita por familia, NO herencia ni fallback. El contrato propuesto usa solo `product` o `sellable`. |
| `F` / `D` / `I` | Candidato a filtro y ficha / solo detalle público / interno administrativo. Exposición configurable, no publicación automática. |
| Desconocido / no aplicable | Estados de captura separados de opciones y de `false`; ausencia no equivale a negación. No sumar estos estados a inventarios de opciones. |
| Alias | Solo equivalencia exacta revisada; búsqueda puede sugerir términos relacionados sin tratarlos como sinónimos ni crear otra faceta. |
| Alcance | Una definición tiene tipo, cardinalidad, unidad, familias, propietario y visibilidad explícitos. Primer corte: rechazar cambios incompatibles con datos existentes, sin reinterpretación, migración ni fijación de versión por producto. |

### Matriz inicial de bindings: propuesta técnica

Basada en el reporte backend `bb06be94-7b84-4d3e-9c87-d1e035df626c`, no capacidad existente ni esquema aprobado. Para el primer contrato, las definiciones tipadas inventariadas se proponen en `sellable`: pueden describir diferencias reales entre presentaciones. El contenido común de ficha permanece en `product`. No imponer invariancia animal/material/etapa ni inventar una prohibición de agrupación.

| Grupo de información | Familias aplicables | Dueño propuesto |
| --- | --- | --- |
| Título comercial, descripción común, imágenes comunes y selección de familia | Las siete; campos del documento, no nuevas opciones | product |
| Animal objetivo y etapa de vida | Donde exista pertinencia declarada; etapa opcional en hábitats | sellable |
| Envase, agrupación vendible y magnitud del contenido | Todas, cuando corresponda | sellable |
| Material: grupos base/rígidos de una sola definición | Juguetes, higiene, accesorios, hábitats | sellable |
| Color, talla y porte declarado | Familias indicadas en los inventarios §5 | sellable |
| Todas las medidas numéricas de §5 | Según aplicabilidad indicada por magnitud, no todas obligatorias | sellable |
| Formato, función, proceso, textura y comportamiento alimenticio | Alimentos; proceso también en premios | sellable |
| Forma y base del premio; tipo y características de juguete | Premios y juguetes respectivamente | sellable |
| Tipo, presentación, base de lecho y fragancia | Higiene | sellable |
| Tipo, cierre y características | Accesorios | sellable |
| Tipo, entorno, sustrato y componentes | Hábitats/equipo | sellable |
| Tipo, presentación y formato de insumo | Cuidado/veterinaria | sellable |
| Lavable, reutilizable e impermeable | Accesorios, higiene y hábitats, solo declaración respaldada | sellable |

Un dueño fijo por definición/familia, no por fila de producto. En producto simple, sellable se guarda en el producto; con variantes, en cada variante real. Aun si dos presentaciones coinciden, no hay fallback al producto ni copia automática. Fuente/fecha de evidencia acompañan el valor respaldado y siguen internas; no validan otras presentaciones por inferencia.

Esta matriz no añade obligatorios a D14 ni genera combinaciones de variantes. Las marcas P→V de las tablas remiten a esta propuesta, no son un tercer dueño. Un futuro atributo realmente invariante puede tener binding product explícito, pero no cambiar de dueño con datos existentes sin revisión de compatibilidad. Campos operativos (nombre POS, marca existente, unidad, impuestos, receta, stock/precio) quedan fuera de estos bindings.

Aceptación futura: 100/500 ml guardan contenido por presentación; azul/100 y rojo/500 no coinciden con azul+500; materiales/animales/etapas diferentes conservan evidencia por presentación sin contaminar la hermana. Cambiar de simple a variantes exige asignación explícita. No prueba soporte de lotes por variante.

### Cobertura auditable, no objetivo de relleno

Cada fila de inventario tiene un prefijo único; las opciones se separan con `;`. El conteo es de pares `clave=etiqueta`, no de especies científicas, combinaciones posibles ni productos disponibles.

| Bloque | Filas de inventario | Opciones propuestas | Cobertura |
| --- | --- | --- | --- |
| Animales (§3) | 22 | 112 | Mamíferos de compañía, aves, reptiles, anfibios, acuarios, granja e invertebrados. |
| Etapas (§4) | 14 | 72 | Perro/gato, pequeños mamíferos, aves, reptiles/anfibios, peces, granja e invertebrados con ciclo identificado. |
| Atributos seleccionables (§5–6) | 31 | 330 | Contenido, envases, materiales, color/talla y siete familias de uso. |
| Total | 67 | 514 | No incluye unidades numéricas, estados de captura, alias ni módulo opcional de razas. |

## 3. Animales: clasificación comercial, especie y raza separadas

`animal_objetivo` sería M, P→V, F, reutilizable en todas las familias **cuando el fabricante declare destinatario**. Su asociación debe guardar fuente y alcance; una clasificación meramente administrativa es I y no rellena ese atributo.
Las agrupaciones de navegación de esta tabla no son opciones adicionales ni parentescos que expandan selecciones. Seleccionar «Perro» no selecciona todas sus razas ni demuestra compatibilidad para una etapa concreta.
**Nivel E**: especie identificada por nombre común, sin asignar nombre científico; **nivel G**: conjunto comercial de múltiples especies o identificación deliberadamente amplia. Verificar identificación antes de canonicalizar; no afirmar equivalencia taxonómica por parecido del nombre. Cada fila comparte nivel; G no se presenta como especie.

| Prefijo | Agrupación de búsqueda | Nivel | Opciones iniciales |
| --- | --- | --- | --- |
| `ani.dom` | Compañía doméstica | E | dog=Perro; cat=Gato; rabbit=Conejo doméstico; ferret=Hurón doméstico; guinea_pig=Cobaya |
| `ani.small` | Pequeños mamíferos identificados | E | syrian_hamster=Hámster sirio; roborovski=Hámster de Roborovski; degu=Degú; fancy_rat=Rata doméstica; house_mouse=Ratón doméstico |
| `ani.small_group` | Pequeños mamíferos: grupos | G | dwarf_hamsters=Hámsteres enanos; gerbils=Jerbos; hedgehogs=Erizos; sugar_gliders=Petauros; dormice=Lirones; chinchillas=Chinchillas domésticas |
| `ani.bird_pet` | Aves de compañía identificadas | E | canary=Canario doméstico; budgerigar=Periquito australiano; cockatiel=Ninfa; zebra_finch=Diamante mandarín; java_sparrow=Gorrión de Java |
| `ani.bird_group` | Aves ornamentales: grupos | G | lovebirds=Agapornis; parrots=Loros; macaws=Guacamayas; cockatoos=Cacatúas; conures=Cotorras y conuros; finches=Pinzones ornamentales |
| `ani.poultry` | Aves de corral identificadas | E | chicken=Gallina doméstica; turkey=Pavo doméstico; guinea_fowl=Gallina de Guinea; pigeon=Paloma doméstica |
| `ani.poultry_group` | Aves de corral: grupos | G | ducks=Patos domésticos; geese=Gansos domésticos; quail=Codornices; pheasants=Faisanes; peafowl=Pavos reales; ratites=Ratites de granja |
| `ani.lizard` | Lagartos identificados | E | leopard_gecko=Gecko leopardo; crested_gecko=Gecko crestado; green_iguana=Iguana verde |
| `ani.lizard_group` | Lagartos: grupos | G | geckos=Geckos; chameleons=Camaleones; anoles=Anolis; skinks=Escíncidos; monitors=Varanos; bearded_dragons=Dragones barbudos |
| `ani.snake` | Serpientes identificadas | E | corn_snake=Serpiente del maíz; ball_python=Pitón bola |
| `ani.reptile_group` | Otros grupos de reptiles | G | boas=Boas; pythons=Pitones; kingsnakes=Serpientes rey; tortoises=Tortugas terrestres; aquatic_turtles=Tortugas acuáticas; semiaquatic_turtles=Tortugas semiacuáticas |
| `ani.amphibian` | Anfibios identificados | E | axolotl=Ajolote mexicano; african_clawed_frog=Rana de uñas africana |
| `ani.amphibian_group` | Anfibios: grupos | G | frogs=Ranas; toads=Sapos; tree_frogs=Ranas arborícolas; newts=Tritones; salamanders=Salamandras |
| `ani.freshwater` | Acuario dulce: identificaciones comunes | E | goldfish=Pez dorado; guppy=Guppy; neon_tetra=Tetra neón; cardinal_tetra=Tetra cardenal; zebrafish=Pez cebra |
| `ani.freshwater_group` | Acuario dulce: grupos | G | bettas=Bettas; mollies=Mollys; platies=Platys; swordtails=Colas de espada; corydoras=Corydoras; plecos=Plecos; cichlids=Cíclidos; gouramis=Guramis; discus=Peces disco |
| `ani.aquatic_other` | Estanque y aguas salobres: grupos | G | koi=Carpas koi; pond_fish=Peces de estanque; brackish_fish=Peces de agua salobre |
| `ani.marine` | Acuario marino: peces por grupo | G | clownfish=Peces payaso; surgeonfish=Peces cirujano; marine_angelfish=Peces ángel marinos; gobies=Gobios marinos; blennies=Blénidos marinos; damselfish=Damiselas; wrasses=Lábridos; butterflyfish=Peces mariposa |
| `ani.aquatic_invert` | Invertebrados de acuario: grupos | G | freshwater_shrimp=Camarones de agua dulce; freshwater_snails=Caracoles de agua dulce; crayfish=Cangrejos de río; marine_shrimp=Camarones marinos; hermit_crabs=Cangrejos ermitaños marinos; corals=Corales; anemones=Anémonas marinas; marine_snails=Caracoles marinos |
| `ani.equine` | Équidos identificados | E | horse=Caballo; donkey=Asno |
| `ani.equine_group` | Équidos: grupo comercial | G | mules=Mulas y burdéganos |
| `ani.farm` | Mamíferos de granja identificados | E | cattle=Bovino doméstico; sheep=Ovino doméstico; goat=Caprino doméstico; pig=Cerdo doméstico; water_buffalo=Búfalo de agua doméstico; llama=Llama; alpaca=Alpaca |
| `ani.terrestrial_invert` | Invertebrados terrestres: grupos | G | tarantulas=Tarántulas; scorpions=Escorpiones; mantises=Mantis; stick_insects=Insectos palo; beetles=Escarabajos; isopods=Isópodos terrestres; land_snails=Caracoles terrestres; bees=Abejas |

### Alias seguros y resolución de ambigüedades

- `ani.dom.guinea_pig`: alias «cuyo», «cuy», «conejillo de Indias»; `ani.bird_pet.cockatiel`: «carolina»; `ani.equine.donkey`: «burro». Revisión regional antes de activarlos; no generan opciones nuevas.
- «Hámster ruso», «periquito», «tortuga», «pez ángel» y «cangrejo» no se asignan automáticamente: pueden ser ambiguos. Mostrar sugerencias y pedir identificación, sin inventar equivalencias.
- Koi se mantiene como grupo comercial, no otra especie distinta de una carpa por el nombre comercial. «Mulas y burdéganos» agrupa híbridos y no se declara especie ni raza.
- Las agrupaciones pueden solaparse (pitón bola/pitones, ajolote/salamandras). Guardar selecciones explícitas, no duplicar conteos por inferencia ni expandir el grupo a sus miembros.
- **Raza** es otra definición opcional, dependiente de animal identificado y fuente comercial. No confundir raza, variedad, color, tamaño o especie; las variedades de peces tampoco se convierten en especies.
- Módulo profundo de razas/variedades: ampliación posterior y curada, no cientos de razas caninas como requisito universal. La amplitud inicial ya está entregada arriba; extenderla no sustituye D12.

## 4. Etapas de vida por grupo

`etapa_vida`: M, P→V, F, para alimentos, premios, juguetes, higiene, accesorios y cuidado solo cuando sea pertinente y esté declarado. Hábitats usa dimensiones/capacidad; etapa es opcional y documentada, nunca una garantía de idoneidad.
No hay edades universales en meses: cada fabricante puede definir sus intervalos. «Adulto» de un ave no reutiliza silenciosamente la definición de un perro. Unir etapas requiere declaración; «todas» no se infiere por ausencia de restricciones.

| Prefijo | Grupo de aplicación | Opciones iniciales |
| --- | --- | --- |
| `life.dog` | Perro | nursing=Lactante; puppy=Cachorro; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia |
| `life.cat` | Gato | nursing=Lactante; kitten=Gatito; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia |
| `life.small` | Pequeños mamíferos; validar especie | nursing=Lactante; juvenile=Juvenil; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia |
| `life.bird` | Aves ornamentales | chick=Polluelo; fledgling=Volantón; juvenile=Juvenil; adult=Adulto; breeding=Reproducción; laying=Puesta |
| `life.poultry` | Aves de corral; validar tipo de ave | starter=Inicio; grower=Crecimiento; developer=Desarrollo; finisher=Finalización; layer=Postura; breeder=Reproductor |
| `life.reptile` | Reptiles | hatchling=Recién eclosionado; juvenile=Juvenil; adult=Adulto; breeding=Reproducción |
| `life.amphibian` | Anfibios según ciclo específico | larval=Larvaria; metamorph=Metamorfosis; juvenile=Juvenil; adult=Adulto |
| `life.aquatic` | Peces; no trasladar a corales o camarones | larval=Larvaria; fry=Alevín; juvenile=Juvenil; adult=Adulto; broodstock=Reproductor |
| `life.equine` | Équidos | nursing=Lactante; foal=Cría; growing=Crecimiento; adult=Adulto; senior=Sénior; gestation=Gestación; lactation=Lactancia |
| `life.farm` | Mamíferos de granja; validar animal | nursing=Lactante; preweaning=Pre-destete; postweaning=Post-destete; growing=Crecimiento; finishing=Finalización; adult=Adulto; gestation=Gestación; lactation=Lactancia |
| `life.crustacean` | Crustáceos; validar ciclo de la especie | larval=Larvaria; postlarval=Postlarvaria; juvenile=Juvenil; adult=Adulto |
| `life.insect_complete` | Insectos con metamorfosis completa | egg=Huevo; larva=Larva; pupa=Pupa; adult=Adulto |
| `life.insect_incomplete` | Insectos con metamorfosis incompleta | egg=Huevo; nymph=Ninfa; adult=Adulto |
| `life.arachnid` | Arácnidos; validar ciclo de la especie | juvenile=Juvenil; subadult=Subadulto; adult=Adulto |

No trasladar estas etapas a moluscos, corales o anémonas: su captura requeriría ciclo identificado y declaración específica, sin herencia por «invertebrado».
«Postura», «finalización» y «reproducción» son fases comerciales/productivas, no edades biológicas equivalentes. No asignarlas a todos los miembros de un grupo ni inferir estado reproductivo del animal comprador.

## 5. Atributos compartidos, unidades y medidas

Las familias propuestas son `food` alimentos, `treat` premios/carnazas, `toy` juguetes, `hygiene` higiene, `accessory` accesorios, `habitat` hábitats/equipamiento y `care` cuidado/veterinaria. Familia define plantilla; categoría organiza navegación. No son equivalentes ni nuevas categorías aprobadas.
Las marcas no se precargan de forma ficticia; se vinculan al núcleo existente. Composición, ingredientes, concentración, análisis y advertencias son declaraciones con fuente, no listas de reclamos sanitarios.

| Prefijo | Definición · tipo · dueño · exposición · familias | Opciones iniciales |
| --- | --- | --- |
| `pack.form` | Envase · U · P→V · D · todas | bag=Bolsa; sack=Saco; can=Lata; pouch=Sobre; tray=Bandeja; jar=Frasco; bottle=Botella; tube=Tubo; box=Caja; blister=Blíster; bucket=Cubeta; tub=Bote; wrap=Envoltura; bulk=Granel |
| `pack.sale` | Agrupación vendible · U · V · D · todas | single=Individual; multipack=Paquete múltiple; kit=Kit; pair=Par; case=Caja comercial; display=Exhibidor; refill=Recarga |
| `content.kind` | Magnitud del contenido · U · V · D · todas | mass=Masa; volume=Volumen; count=Conteo; length=Longitud; area=Superficie |
| `material.base` | Materiales declarados · M · P→V · F · toy/hygiene/accessory/habitat | rubber=Caucho; latex=Látex; silicone=Silicona; tpr=Elastómero termoplástico; nylon=Poliamida; polyester=Poliéster; cotton=Algodón; hemp=Cáñamo; jute=Yute; sisal=Sisal; rope=Cuerda de fibra no especificada; fleece=Tejido polar; felt=Fieltro; plush=Tejido de peluche |
| `material.rigid` | Materiales rígidos/minerales · M · P→V · F · toy/hygiene/accessory/habitat | stainless=Acero inoxidable; steel=Acero; aluminium=Aluminio; plastic=Plástico no especificado; polypropylene=Polipropileno; polyethylene=Polietileno; abs=ABS; pvc=PVC; acrylic=Acrílico; glass=Vidrio; ceramic=Cerámica; wood=Madera; bamboo=Bambú; cardboard=Cartón; paper=Papel; stone=Piedra |
| `color.base` | Color comercial · M · P→V · F · toy/accessory/habitat | black=Negro; white=Blanco; grey=Gris; brown=Café; beige=Beige; red=Rojo; orange=Naranja; yellow=Amarillo; green=Verde; blue=Azul; purple=Morado; pink=Rosa; transparent=Transparente; multicolor=Multicolor; assorted=Surtido |
| `size.label` | Talla comercial · U · V · F · toy/accessory | xxs=XXS; xs=XS; s=S; m=M; l=L; xl=XL; xxl=XXL; xxxl=XXXL; adjustable=Ajustable; one_size=Talla única |
| `size.animal` | Porte declarado · M · P→V · F · food/treat/toy/accessory | miniature=Miniatura; small=Pequeño; medium=Mediano; large=Grande; giant=Gigante |

Cuerda/peluche describen construcción o tejido, no composición exacta: solicitar detalle cuando importe. Plástico no especificado no equivale a ABS; no seleccionar materiales concretos por apariencia. «Surtido» no promete poder elegir cada color.
El porte no tiene umbrales universales entre animales. Talla M no sustituye contorno/largo ni acredita ajuste; guardar tabla del fabricante como referencia. Color/talla que cambia identidad vendible pertenece a V: almacenar en el producto simple o en cada variante real, según corresponda, sin crear combinaciones. Un atributo puramente común usa P según el binding de familia.

### Números con unidad: escribir la medida, no miles de opciones

| Código de definición | Tipo / dueño / exposición | Unidades admitidas propuestas y validación |
| --- | --- | --- |
| `measure.net_mass` | N / V / F | `mg`, `g`, `kg`; mayor que cero, contenido neto por identidad vendible. |
| `measure.net_volume` | N / V / F | `ml`, `l`; mayor que cero. No convertir masa↔volumen sin contrato específico. |
| `measure.content_count` | N entero / V / D | `piece` (pieza), `dose_unit` (unidad declarada, no dosis recomendada), `sheet` (hoja), `roll` (rollo); mayor que cero. |
| `measure.pack_count` | N entero / V / D | `unit` (unidad interior); junto al contenido por unidad cuando se conozca, sin multiplicar inventario automáticamente. |
| `measure.dimensions` | N por eje / P→V / F | `mm`, `cm`, `m`; largo/ancho/alto/diámetro separados, cada uno positivo. No mezclar medidas interiores y exteriores. |
| `measure.fit` | N rango / V / F | `cm`, `mm`; contorno cuello/pecho y largo de espalda separados; mínimo ≤ máximo, sin inferir talla. |
| `measure.animal_mass` | N rango / P→V / F | `g`, `kg`; rango objetivo declarado, positivo; no sustituye compatibilidad por especie. |
| `measure.capacity` | N / V / F | `ml`, `l` para capacidad de recipiente; distinta de contenido neto y volumen útil documentado del hábitat. |
| `measure.equipment` | N por magnitud / V / D | `W`, `V`, `Hz`, `l/h`, `°C`; potencia/tensión/frecuencia/caudal/rango térmico separados. No deducir compatibilidad eléctrica o animal. |
| `measure.coverage` | N / V / D | `m`, `m²` para rollos/mallas; distinguir longitud de superficie. |

Aplicabilidad numérica: contenido/conteo/paquete en todas las familias si existe; dimensiones en juguetes/accesorios/hábitats e insumos físicos de higiene/cuidado; ajuste en accesorios; masa objetivo donde se declare; capacidad en accesorios/hábitats; especificaciones de equipo en hábitats/accesorios; cobertura en higiene/hábitats.
Permitir decimales descriptivos de medida **no** habilita venta fraccionada. Catálogo de unidades cerrado por magnitud; rechazar unidad desconocida o de otra magnitud. Conversión descriptiva solo entre unidades compatibles y con regla acordada, nunca hacia stock/precio.
En núcleo operativo conservar unidad de venta existente; no reemplazarla por `content.kind`. Ejemplo: paquete de 3 sobres de 85 g separa agrupación, conteo y contenido individual; no implica stock de 255 unidades ni venta de sobres sueltos.

## 6. Inventarios por familia

Solo mostrar definiciones pertinentes. Cada fila propone cardinalidad, propiedad y exposición; opciones no activan variantes ni afirmaciones. Valores como «sin fragancia» o «contiene catnip» requieren etiqueta/ficha verificable, no deducción del nombre.

| Prefijo | Definición · tipo · dueño · exposición · familia | Opciones iniciales |
| --- | --- | --- |
| `food.format` | Formato · U · P→V · F · food | kibble=Croquetas; pellet=Pellets; flake=Hojuelas; granule=Gránulos; stick=Barritas; wafer=Discos alimenticios; pate=Paté; chunks=Trozos; mousse=Mousse; broth=Caldo; powder=Polvo; seed_mix=Mezcla de semillas; hay=Heno; forage=Forraje; frozen=Congelado; freeze_dried=Liofilizado |
| `food.role` | Función alimentaria declarada · U · P→V · F · food | complete=Alimento completo; complementary=Alimento complementario; supplemental=Suplemento alimenticio; milk_replacer=Sustituto lácteo; forage=Forraje; breeding_feed=Alimento para reproductores |
| `food.process` | Procesamiento declarado · M · P→V · D · food/treat | extruded=Extruido; baked=Horneado; dehydrated=Deshidratado; freeze_dried=Liofilizado; canned=Enlatado; frozen=Congelado; air_dried=Secado al aire; cold_pressed=Prensado en frío |
| `food.texture` | Textura · M · P→V · F · food/treat | dry=Seca; moist=Húmeda; semimoist=Semihúmeda; soft=Blanda; crunchy=Crujiente; liquid=Líquida; gel=Gel |
| `food.aquatic` | Comportamiento acuático declarado · U · P→V · F · food | floating=Flotante; slow_sinking=Hundimiento lento; sinking=De fondo; suspended=En suspensión |
| `treat.form` | Forma de premio/carnaza · U · P→V · F · treat | bite=Bocaditos; biscuit=Galleta; strip=Tira; cube=Cubo; stick=Palito; roll=Rollo; ring=Aro; knot=Nudo; braid=Trenza; bone_shape=Forma de hueso; lickable=Premio para lamer; paste=Pasta; dried_piece=Pieza deshidratada |
| `treat.base` | Base declarada · M · P→V · D · treat | rawhide=Carnaza de piel; meat=Carne; fish=Pescado; vegetable=Vegetal; cereal=Cereal; dairy=Lácteo; insect=Insectos |
| `toy.type` | Tipo de juego · M · P→V · F · toy | ball=Pelota; rope=Cuerda de juego; tug=Tirador; plush=Peluche; chew=Mordedor; puzzle=Rompecabezas; dispenser=Dispensador; wand=Varita; teaser=Señuelo; tunnel=Túnel; wheel=Rueda; swing=Columpio; mirror=Espejo; climbing=Trepa; floating=Juguete flotante |
| `toy.feature` | Característica declarada · M · P→V · F · toy | squeaker=Con sonido al presionar; crinkle=Con material crujiente; bell=Con cascabel; catnip=Contiene catnip; refillable=Rellenable; treat_dispensing=Dispensa premios; suction=Con ventosa; interactive=Interactivo; battery=Funciona con pilas; rechargeable=Recargable |
| `hygiene.type` | Tipo de higiene · U · P→V · F · hygiene | shampoo=Champú; conditioner=Acondicionador; wipes=Toallitas; brush=Cepillo; comb=Peine; slicker=Carda; clipper=Cortadora; nail_clipper=Cortaúñas; file=Lima; towel=Toalla; pad=Tapete absorbente; diaper=Pañal; bag=Bolsa para residuos; litter=Arena sanitaria; scoop=Pala sanitaria; cleaner=Limpiador de entorno |
| `hygiene.form` | Presentación de higiene · U · P→V · F · hygiene | liquid=Líquido; foam=Espuma; spray=Atomizador; gel=Gel; powder=Polvo; bar=Barra; wipe=Toallita; granule=Granulado |
| `hygiene.litter` | Base de lecho sanitario · M · P→V · F · hygiene | bentonite=Bentonita; silica=Sílice; paper=Papel; wood=Madera; corn=Maíz; tofu=Derivado de soya; walnut=Cáscara de nuez; grass=Fibras de pasto |
| `hygiene.scent` | Fragancia declarada · U · P→V · D · hygiene | unscented=Sin fragancia añadida; scented=Con fragancia; unspecified=Fragancia no especificada por fabricante |
| `accessory.type` | Tipo de accesorio · U · P→V · F · accessory | collar=Collar; harness=Arnés; leash=Correa; long_line=Línea larga; tag=Placa; muzzle=Bozal; carrier=Transportadora; stroller=Carriola; bowl=Comedero; drinker=Bebedero; fountain=Fuente; bed=Cama; mat=Colchoneta; coat=Abrigo; boots=Botas; saddle_pad=Mantilla; halter=Cabezada de cuadra; lead_rope=Ramal |
| `accessory.closure` | Cierre · M · P→V · D · accessory | buckle=Hebilla; quick_release=Broche de liberación rápida; hook_loop=Cierre de gancho y bucle; zipper=Cremallera; snap=Broche a presión; tie=Amarre; carabiner=Mosquetón; screw=Tornillo |
| `accessory.feature` | Característica declarada · M · P→V · F · accessory | adjustable=Ajustable; reflective=Reflectante; padded=Acolchado; foldable=Plegable; removable_cover=Funda desmontable; nonslip=Base antideslizante; elevated=Elevado; double=Doble; portable=Portátil; wall_mount=Montaje en pared |
| `habitat.type` | Tipo de hábitat/equipo · U · P→V · F · habitat | cage=Jaula; aviary=Aviario; hutch=Conejera; pen=Corral; terrarium=Terrario; paludarium=Paludario; aquarium=Acuario; pond=Estanque; coop=Gallinero; shelter=Refugio; nest=Nido; incubator=Incubadora; filter=Filtro; pump=Bomba; heater=Calentador; lamp=Lámpara |
| `habitat.environment` | Entorno declarado · M · P→V · F · habitat | terrestrial=Terrestre; arboreal=Arborícola; semiaquatic=Semiacuático; freshwater=Agua dulce; brackish=Agua salobre; marine=Marino; indoor=Interior; outdoor=Exterior |
| `habitat.substrate` | Base de sustrato · M · P→V · F · habitat | coconut=Fibra de coco; bark=Corteza; soil=Tierra; sand=Arena; gravel=Grava; clay=Arcilla; paper=Papel; hemp=Cáñamo; straw=Paja; wood_shavings=Viruta de madera; moss=Musgo; mineral_mix=Mezcla mineral |
| `habitat.component` | Componente/equipamiento · M · P→V · F · habitat | perch=Percha; platform=Plataforma; hide=Escondite; ramp=Rampa; feeder=Alimentador; dripper=Gotero; misting=Nebulización; thermostat=Termostato; thermometer=Termómetro; hygrometer=Higrómetro; timer=Temporizador; aeration=Aireación; lighting=Iluminación; filtration=Filtración |
| `care.type` | Tipo comercial de cuidado · U · P→V · F · care | grooming=Cuidado externo; oral_hygiene=Higiene oral; wound_supplies=Material de curación; dressing=Apósitos; bandage=Vendajes; protective_collar=Collar protector; instrument=Instrumental; dosing_device=Dispositivo de administración; supplement=Suplemento declarado; medicine=Medicamento declarado; diagnostic_supply=Insumo diagnóstico |
| `care.form` | Presentación declarada · U · P→V · F · care | tablet=Tableta; capsule=Cápsula; powder=Polvo; granule=Granulado; solution=Solución; suspension=Suspensión; emulsion=Emulsión; drops=Gotas; gel=Gel; cream=Crema; ointment=Ungüento; spray=Atomizador; paste=Pasta; ampoule=Ampolleta; vial=Vial; sachet=Sobre |
| `care.device` | Formato de insumo · U · P→V · D · care | gauze=Gasa; pad=Compresa; roll=Rollo; strip=Tira; syringe=Jeringa; dropper=Gotero; applicator=Aplicador; measuring_cup=Vaso medidor; swab=Hisopo; glove=Guante |

«Fragancia no especificada» solo recoge declaración explícita del fabricante; si no hay información, usar estado desconocido. No es «sin fragancia». «Forma de hueso» no afirma composición ósea; «carnaza» no indica especie de origen.
Ingredientes/origen proteico pueden capturarse como T documentado inicialmente; no inferir «hipoalergénico», «sin cereales», «dental», «antiparasitario» o «apto renal» a partir de composición o categoría. Cualquier reclamo futuro requiere criterio y evidencia propios.
Otros campos: `feature.washable`, `feature.reusable`, `feature.waterproof` serían B, P→V, D en accesorios/higiene/hábitats; registrar verdadero o falso solo si está declarado. `source.reference` y `source.checked_at` serían I; ficha/advertencias publicables requieren revisión independiente.
Concentración/composición en care: T documentado o magnitudes estructuradas por contrato posterior; no inventar opciones de dosis ni normalizaciones clínicas. Requisito de receta y controles regulatorios permanecen en el núcleo, no en un select editable que permita evadirlos.

## 7. Mínimos de publicación aprobados (D14), aún no implementados

Todas conservan identidad y reglas comerciales del núcleo. Los mínimos de la tabla están aprobados como regla de publicación (D14); no son validaciones ya implementadas. Los campos sugeridos siguen opcionales y se conservan todas las condiciones de pertinencia. **D13 sí está aprobada:** tanto altas como productos publicados permiten un único borrador privado persistente con obligatorios desconocidos/incompletos, nunca tipos, códigos, unidades o referencias de otro tenant inválidos. Retomar entre sesiones, previsualizar/comparar, publicar atómicamente o descartar son requisitos del primer corte, no mejoras opcionales.

Refinamiento backend `1e6135c1-f360-4a95-a4e6-dc5d882be2a3`, propuesto y no API: `Draft {revision, basePublishedRevision, document}` y `Published {revision, document}`. El documento contiene `commercialTitle`, descripción, `mediaRefs` ordenadas, `familyCode` y bindings/valores `product` o `sellable`. Título comercial no es `Product.name` ni afecta POS/recibos: copia inicial explícita opcional, nunca sincronización; la integración exacta aún requiere evidencia backend.

Guardar valida captura sin exigir completitud; dato malformado se rechaza sin mutación ni cambio de revisión. Publicar revalida en transacción mínimos acordados, definiciones vigentes, todas las variantes actualmente ofrecidas/referenciadas, pertenencia/elegibilidad y medios; éxito reemplaza publicado y consume borrador atómicamente. Una referencia archivada/eliminada después de guardar queda diagnosticada en el borrador, no lo elimina: publicación fallida conserva tanto borrador como publicado para corregir. No resucitar variantes ni aceptar la carrera validar–eliminar–publicar.

No versionar ni restaurar nombre operativo, SKU/código de barras, existencia/estado de variantes, precios/promociones/impuestos, stock/lotes/caducidad, unidad de venta, visibilidad/acceso ni receta. Publicar descripción no enciende visibilidad; reglas operativas siguen vivas. La recomendación anterior de no persistir ediciones incompletas de publicados queda sustituida por D13.

| Familia | Mínimo aprobado para publicar, además del núcleo | Sugerido cuando exista evidencia |
| --- | --- | --- |
| Alimentos | Destinatario declarado, formato, contenido y unidad por presentación. | Etapa, función alimentaria, textura, composición/análisis con fuente. |
| Premios/carnazas | Destinatario declarado, forma, contenido/piezas y unidad. | Base, medidas, textura, etapa y advertencias del fabricante. |
| Juguetes | Tipo, destinatario declarado y dimensiones relevantes para el uso. | Materiales, porte, características y supervisión indicada en etiqueta. |
| Higiene | Tipo, presentación/contenido cuando sea consumible; destinatario si se aplica al animal. | Base del lecho, fragancia y modo de uso documentado; limpiador ambiental no hereda especies. |
| Accesorios | Tipo y medidas de ajuste/capacidad cuando determinen elección. | Material, talla/color, destinatario y características verificadas. |
| Hábitats/equipo | Tipo y medidas/capacidad pertinentes; especificaciones eléctricas cuando corresponda. | Entorno, componentes y compatibilidad concreta documentada, no «sirve para todo reptil». |
| Cuidado/veterinaria | Tipo, presentación, contenido y documentación/advertencias requeridas según producto. | Destinatario indicado y composición; resolver reglas legales/receta antes de habilitar publicación afectada. |

D14 aprueba estos mínimos por familia; resta especificar técnicamente su aplicabilidad por subtipo, sin añadir obligatorios ni presumir una adopción retroactiva en productos existentes; no hacer obligatorio animal objetivo para una bomba sin destinatario animal declarado ni inventar uno para completar formulario. Registro interno de fuente no implica publicar documentos privados.
Producto comparte marca/descripción y valores comunes; V tiene contenido, talla/color/medidas o formato que cambien identidad vendible. V se almacena en producto simple si no hay variantes, o exclusivamente en variantes reales si las hay. Dos envases de 100/500 ml no prueban lotes por variante disponibles. Ninguna opción genera automáticamente todas las combinaciones.

Refinamiento técnico propuesto (backend `f0b0bb90-aa54-409a-8cf3-3b7b65cfe79b`): cada binding de familia fija `ownerScope: product | sellable`, sin herencia. Habilitar/deshabilitar variantes exige asignación explícita del nuevo dueño vendible y validación atómica; valores anteriores conservan traza pero no son fallback. No copiar/repartir stock, precio ni lotes como efecto descriptivo. `material.base` y `material.rigid` son grupos de opciones de UNA definición material multiselección; sus prefijos no crean atributos o facetas separados. Normalizar por separado definiciones, grupos, opciones y alias conservando códigos.

## 8. Administración y filtros sin carga innecesaria

1. **Entrar con permisos efectivos:** reutilizar el modelo granular existente y su editor; mapear consultar, editar definiciones/opciones, asignar valores y consultar trazas con los agentes. Editar/guardar borrador y publicar son permisos separados que el usuario combina en roles, sin segundo aprobador obligatorio, roles fijos ni nombres técnicos de permisos inventados.
   D17 aprobado: diccionario/plantillas comunes para CEDIS y sucursales de la empresa, mantenidos por actores autorizados; valores producto/variante conservan aislamiento por tenant. Compartir opciones no concede acceso cruzado a productos, existencias, precios ni clientes. Resolver y verificar vínculo empresarial y permisos efectivos antes de habilitar mutaciones compartidas.
2. **Explorar:** buscar por etiqueta/código/alias, agrupar por familia y nivel animal, mostrar tipo/unidad/propietario/estado. Catálogos administrativos incluyen las opciones iniciales aunque todavía no tengan productos.
3. **Asignar:** familia muestra campos pertinentes, U/M claros, búsqueda con teclado y selección múltiple mediante etiquetas removibles. Presentar todas las coincidencias accesibles con paginación si hace falta; no limitar a cinco sugerencias.
4. **Alta controlada:** primero buscar posibles duplicados; después proponer código, etiqueta, nivel/alcance, unidad o alias y fuente. Vista previa antes de confirmar; alta desde producto no crea variantes ni publica automáticamente.
5. **Colisiones:** normalizar mayúsculas/espacios y acentos para detección, no para fusionar identidades. Bloquear código repetido y alias que apunte a dos opciones en el mismo alcance; homónimos necesitan desambiguación visible y revisión.
6. **Renombrar/archivar:** preservar código y referencias; registrar actor, motivo, fecha y antes/después. D16: archivado impide nuevas asignaciones, conserva valores e historial y muestra advertencia en edición. Valores válidos ya publicados y sus filtros permanecen sujetos a elegibilidad vigente; republicar requiere reemplazar/quitar la opción respetando D14. Datos incorrectos/peligrosos requieren corrección o retiro explícito, no solo archivo. No extender esta conservación a variantes o medios archivados.
7. **Actualizar vocabulario versionado:** comparar versión base, cambios locales y entrega nueva por código. Agregar sin pisar etiquetas/alias personalizados; conflictos a revisión, sin borrado ni resurrección automática de opciones archivadas. Registrar procedencia y resultado de cada actualización.
8. **Borrador/publicación D13:** distinguir publicado/no publicado, borrador guardado y cambios locales sin guardar; avisar al salir. Crear/retomar el único borrador, guardar, preview/diff autenticados `no-store`, publicar y descartar con confirmación. CAS de revisiones protege guardar/publicar/descartar; descarte obsoleto no elimina borrador nuevo ni publicado. Fallo conserva ambas versiones y entradas locales para corregir/conflicto, sin despublicación silenciosa. No añade ramas ni historial ilimitado.
9. **Privacidad/medios:** assets referidos pertenecen al tenant; rechazar cruces de tenant. Medios exclusivos del borrador privados, sin URL estable/CDN público; preview/diff, notas internas y documentos privados fuera de respuestas/cachés/índices públicos. Retener imágenes mientras borrador o publicado las refieran; cambiar/descartar no elimina medios compartidos/publicados ni hace limpieza inline. Huérfanos se tratan aparte, sin API de almacenamiento propuesta aquí.

Filtros públicos leen solo contenido descriptivo publicado y productos/presentaciones visibles y elegibles en vivo para el contexto comercial, **antes de paginar**, con igual elegibilidad para resultados y conteos. Nunca leen borradores/previews; caché pública solo de publicado con revisión e invalidación. Diccionario amplio administrativo no obliga a un muro de filtros vacíos.
Recomendación de conteo por faceta: aplicar los demás filtros y omitir solo las selecciones de esa faceta. Mantener siempre elegibilidad, privacidad, categoría, texto y familia; nunca contar desde todo el diccionario ni relajar esos límites.
Regla propuesta: OR entre valores seleccionados del mismo atributo; AND entre atributos distintos. Los predicados vendibles V deben satisfacerse en el producto simple o en **una misma variante elegible**, sin herencia P→V ni combinación de hermanas. Contar productos únicos, no sumar cada variante coincidente como producto distinto.
Solo publicar facetas F pertinentes con resultados; D muestra detalle sin faceta e I nunca sale al público. Selecciones activas que pasan a cero siguen visibles para poder quitarlas; no ocultarlas silenciosamente ni anunciar opciones de otros contextos privados.

## 9. Primer corte: aceptación futura y decisiones pendientes

**Ejemplos para pruebas futuras, no tests ejecutados ni garantías de implementación.** Primer corte propuesto: búsqueda/asignación animal, etapas pertinentes, contenido y materiales; probar alimentos de perro, premio de conejo, juguete de ave, acuario y cuidado 100/500 ml como casos distintos.

| Caso | Resultado esperado |
| --- | --- |
| Buscar «cuyo» y «cobaya» | Misma opción `ani.dom.guinea_pig`; una sola faceta/conteo, sin producto compatible añadido por el alias. |
| Seleccionar «Pitones» | No seleccionar automáticamente pitón bola ni afirmar compatibilidad del producto con todas las pitones. |
| Buscar nombre ambiguo «pez ángel» | Pedir elección identificada; no equiparar acuario dulce y marino ni crear un sinónimo transversal. |
| Producto con V1 azul/100 ml y V2 rojo/500 ml | Azul + 500 ml no coincide; azul + 100 ml sí, si V1 es elegible. No combinar valores de hermanas. |
| Contenido 500 con unidad desconocida o `cm` para volumen | Rechazo de la captura afectada, sin valor parcial persistido ni conversión a inventario. |
| Característica sin dato | No interpretar como falso ni «no aplicable»; no inferir ausencia de fragancia o reclamo sanitario. |
| Renombrar «Cobaya» | Conserva código, referencias y resultado de búsqueda mediante alias aprobado; historial muestra cambio. |
| Archivar opción ya utilizada | Sin nuevas asignaciones; historia/referencias intactas y advertencia al editar, sin borrar productos. |
| Edición sin permiso efectivo o fuera de alcance | Rechazo autoritativo sin escrituras parciales ni exposición de información de otro alcance. |
| Nueva versión con etiqueta editada localmente | Conflicto visible; no sobrescribir personalización ni reactivar archivado automáticamente. |
| Buscar material y navegar con teclado | Opciones agrupadas, todas alcanzables; M permite varias selecciones y quitar cada una sin perder foco. |
| Faceta administrativa sin productos públicos elegibles | Disponible para captura autorizada, ausente como opción pública sin resultados; conteo no cambia al paginar. |
| Guardar incompleto sobre un publicado y recargar en otra sesión | Recupera el único borrador privado; la versión descriptiva pública anterior permanece sin cambios. Captura malformada no cambia revisión. |
| Referencia válida al guardar, archivada/eliminada antes de publicar | Sigue diagnosticada en borrador; publicar falla conservando ambas versiones, sin resurrección de variante ni pérdida del borrador. |
| Editor sin permiso de publicación; otro editor guarda después | Puede guardar pero no publicar; CAS rechaza guardado/publicación/descarte obsoleto sin perder revisiones. |
| Actualizar título, imágenes y atributos; publicar o descartar | Solo afecta descripción; no altera nombre operativo/SKU/stock/precio/receta/visibilidad. Publicar exitoso consume borrador; fallo conserva ambas versiones. |
| Preview, media ajena o imagen compartida con publicado | Preview/diff privados `no-store`; acceso cruzado denegado. Sin filtración pública de borrador/media; descartar no borra recursos referidos por publicado. |

Pendientes de validación: representación y autorización del ámbito empresarial D17; lista y nombres canónicos definitivos; validar la matriz inicial product/sellable y su aplicabilidad por familia (sin herencia); aplicabilidad de los mínimos D14 por subtipo; alias regionales y nombres comunes ambiguos. D13, los mínimos por familia D14, la política de opciones archivadas D16 y el diccionario común D17 no son puertas comerciales pendientes: backend debe verificar persistencia/CAS, transacción, medios, privacidad/caché y adopción de datos actuales antes de implementar el contrato propuesto. Los 514 códigos son el conteo verificado de opciones propuestas, no 514 definiciones ni opciones activas ya aprobadas. Son validaciones del siguiente corte, no carencias que obliguen a entregar selectores vacíos.
Responsabilidad técnica y contratos quedan con frontend principal y peer backend. No se propone API, esquema, seed ejecutable ni acceso a bases/repositorios externos. Siguiente paso: revisar esta cobertura con negocio y cerrar únicamente las decisiones G1 afectadas.
