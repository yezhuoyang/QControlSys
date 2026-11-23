import QControl.Neutral

/-! A metric layout for the crossed-AOD bench. Positions use a right-handed frame:
    +Y is up, +X is the incident beam direction, and the local tweezer coordinates
    (x,y) are parallel to (+X,−Z). Decimal millimetres serialize exactly. -/
namespace QControl.Neutral
open Lean

namespace Layout

structure Point where
  x : JsonNumber
  y : JsonNumber
  z : JsonNumber

instance : ToJson Point where
  toJson p := toJson #[p.x, p.y, p.z]

structure Part where
  id : String
  label : String
  kind : String
  centerMm : Point
  sizeMm : Point
  basis : String
  deriving ToJson

structure Link where
  id : String
  kind : String
  «from» : String
  to : String
  pointsMm : List Point
  diameterMm : JsonNumber
  deriving ToJson

structure Focus where
  id : String
  label : String
  centerMm : Point
  spanMm : JsonNumber
  deriving ToJson

structure Source where
  title : String
  url : String
  deriving ToJson

def sources : List Source := [
  ⟨"Thorlabs B6090AE breadboard dimensions",
   "https://www.thorlabs.com/catalogpages/Obsolete/2017/B6090AE.pdf"⟩,
  ⟨"nVent SCHROFF Comptec 10225-601 case dimensions",
   "https://schroff.nvent.com/sites/g/files/hdkjer281/files/acquiadam/2020-11/05_e_desktop_cases.pdf"⟩,
  ⟨"Isomet D55-T80S-2 near-infrared deflector outline and access time",
   "https://isomet.com/PDF%20acousto-optics_deflectors/Data%20sheets%20-%20defnir/D55-T80S-2%20%28NIR%29.pdf"⟩,
  ⟨"Mitutoyo M Plan Apo NIR 50× dimensions, field and nominal working distance",
   "https://www2.mitutoyo.co.jp/eng/support/service/catalog/04/E14020.pdf"⟩,
  ⟨"Bluvstein et al., crossed-AOD atom transport (2022)",
   "https://doi.org/10.1038/s41586-022-04592-6"⟩]

def sample : Point := ⟨150, 100, 30⟩

private def lens (id name : String) (x : JsonNumber) : Part :=
  ⟨id, name, "lens", ⟨x, 225, 30⟩, ⟨3, 25.4, 25.4⟩,
    "Assumed thin-lens relay station in a 25.4 mm optic envelope. Optical axis along +X."⟩

private def support (id name : String) (center size : Point) : Part :=
  ⟨id, name, "support", center, size, "Assumed support envelope and placement."⟩

def parts : List Part := [
  ⟨"table", "Optical breadboard", "table", ⟨0, -29, 0⟩, ⟨900, 58, 600⟩,
   "Thorlabs B6090AE catalogue envelope. The upper mounting surface defines Y = 0 mm."⟩,
  ⟨"chassis", "3U desktop controller chassis", "chassis", ⟨-140, 76.5, -150⟩, ⟨520, 153, 300⟩,
   "nVent SCHROFF Comptec 10225-601 case envelope, excluding feet. Board population and placement assumed."⟩,
  ⟨"controller", "Sequencer FPGA card", "fpga", ⟨-250, 76.5, -82⟩, ⟨22, 100, 160⟩,
   "Assumed populated vertical control-card envelope inside the chassis."⟩,
  ⟨"dds", "Multitone DDS and RF output card", "dds", ⟨-110, 76.5, -82⟩, ⟨30, 100, 160⟩,
   "Assumed populated vertical card with two independent amplified RF outputs. Ports face +Z."⟩,
  ⟨"laser", "Tweezer laser head", "laser", ⟨-335, 225, 30⟩, ⟨150, 56, 60⟩,
   "Assumed collimated trapping-light source and enclosure. Power and beam waist are unspecified."⟩,
  ⟨"aod-x", "Column acousto-optic deflector", "aod", ⟨-180, 226.02, 37.61⟩, ⟨22.34, 16, 50.76⟩,
   "Isomet D55-T80S-2 housing excluding SMA connector. Aperture offset uses the mechanical outline. Mount pose assumed."⟩,
  lens "relay-x1" "First 50 mm relay lens" (-130), lens "relay-x2" "Second 50 mm relay lens" (-30),
  ⟨"aod-y", "Row acousto-optic deflector", "aod", ⟨20, 232.61, 28.98⟩, ⟨22.34, 50.76, 16⟩,
   "Same Isomet housing rolled through 90 degrees about the chief ray. Mount and Bragg-angle alignment are idealized."⟩,
  lens "relay-y1" "First 40 mm relay lens" 60, lens "relay-y2" "Second 40 mm relay lens" 140,
  ⟨"fold", "Downward fold mirror", "mirror", ⟨150, 225, 30⟩, ⟨9, 9, 12.7⟩,
   "Assumed 12.7 mm mirror at 45 degrees. The box encloses its projected disk."⟩,
  ⟨"objective", "50× focusing objective", "objective", ⟨150, 156, 30⟩, ⟨34, 78, 34⟩,
   "Mitutoyo M Plan Apo NIR 50× barrel Ø34 × 78 mm. The nose sits 17 mm above the sample at nominal working distance. Window aberration and focal shift are idealized."⟩,
  ⟨"chamber", "Vacuum science cell", "chamber", sample, ⟨60, 22, 38⟩,
   "Assumed shallow rectangular vacuum cell, cut away for optical access in the view."⟩,
  ⟨"window", "Top optical window", "window", ⟨150, 110.5, 30⟩, ⟨26, 1, 24⟩,
   "Assumed 1 mm window on the upper cell wall. No glass refraction is evaluated."⟩,
  ⟨"array", "Atom plane at objective focus", "array", sample, ⟨0.6, 0, 0.6⟩,
   "Field annotation with the objective catalogue's 0.6 mm diameter (field number 30). The zero-thickness plane is a coordinate reference."⟩,
  support "laser-base" "Laser mounting pedestal" ⟨-335, 98.5, 34⟩ ⟨100, 197, 48⟩,
  support "aod-x-post" "Column deflector post" ⟨-180, 109.01, 37.61⟩ ⟨14, 218.02, 14⟩,
  support "aod-y-post" "Row deflector post" ⟨20, 103.615, 28.98⟩ ⟨14, 207.23, 14⟩,
  support "cell-base" "Cell pedestal" ⟨150, 44.5, 30⟩ ⟨54, 89, 32⟩,
  support "objective-post" "Objective and fold post" ⟨184, 112.5, 52⟩ ⟨16, 225, 16⟩,
  support "objective-arm" "Objective mounting arm" ⟨169, 164, 49⟩ ⟨32, 8, 16⟩,
  support "fold-arm" "Fold-mirror mounting arm" ⟨167, 225, 45⟩ ⟨38, 5, 20⟩,
  support "relay-x1-post" "First relay post" ⟨-130, 106.15, 30⟩ ⟨12, 212.3, 12⟩,
  support "relay-x2-post" "Second relay post" ⟨-30, 106.15, 30⟩ ⟨12, 212.3, 12⟩,
  support "relay-y1-post" "Third relay post" ⟨60, 106.15, 30⟩ ⟨12, 212.3, 12⟩,
  support "relay-y2-post" "Fourth relay post" ⟨140, 106.15, 69⟩ ⟨12, 212.3, 12⟩,
  support "relay-y2-arm" "Last relay side bracket" ⟨140, 210.8, 49.5⟩ ⟨12, 5, 40⟩]

private def optical (src dst : String) (a b : Point) : Link :=
  ⟨src ++ "-to-" ++ dst, "optical", src, dst, [a, b], 0.6⟩

private def rail (x : JsonNumber) : Point := ⟨x, 225, 30⟩

def links : List Link := [
  ⟨"control-bus", "digital", "controller", "dds",
   [⟨-250, 72, -162⟩, ⟨-250, 72, -170⟩, ⟨-110, 72, -170⟩, ⟨-110, 72, -162⟩], 4⟩,
  ⟨"rf-x", "rf", "dds", "aod-x",
   [⟨-110, 88, -2⟩, ⟨-110, 88, 23⟩, ⟨-140, 75, 86⟩, ⟨-180, 180, 86⟩, ⟨-180, 226.02, 62.99⟩], 3⟩,
  ⟨"rf-y", "rf", "dds", "aod-y",
   [⟨-110, 100, -2⟩, ⟨-110, 100, 17⟩, ⟨0, 150, 80⟩, ⟨20, 272, 75⟩, ⟨20, 257.99, 28.98⟩], 3⟩,
  optical "laser" "aod-x" (rail (-260)) (rail (-180)),
  optical "aod-x" "relay-x1" (rail (-180)) (rail (-130)),
  optical "relay-x1" "relay-x2" (rail (-130)) (rail (-30)),
  optical "relay-x2" "aod-y" (rail (-30)) (rail 20),
  optical "aod-y" "relay-y1" (rail 20) (rail 60),
  optical "relay-y1" "relay-y2" (rail 60) (rail 140),
  optical "relay-y2" "fold" (rail 140) (rail 150),
  optical "fold" "objective" (rail 150) ⟨150, 195, 30⟩,
  optical "objective" "window" ⟨150, 117, 30⟩ ⟨150, 110.5, 30⟩,
  optical "window" "array" ⟨150, 110.5, 30⟩ sample]

/-- Sample-plane displacements in integer nm map to global integer nm exactly. -/
def worldNm (xNm yNm : Int) : Int × Int × Int :=
  (150000000 + xNm, 100000000, 30000000 - yNm)

theorem world_displacement (x y dx dy : Int) :
    (worldNm (x + dx) (y + dy)).1 - (worldNm x y).1 = dx ∧
    (worldNm (x + dx) (y + dy)).2.2 - (worldNm x y).2.2 = -dy := by
  simp only [worldNm]; omega

def boundsNm (p : Program) (axis : Axis) : Int × Int :=
  let endpoints := (p.tones.read axis) ++ (p.moves.filter fun m ↦ m.axis == axis).map Move.targetKHz
  let values := endpoints.map (positionNm p)
  (values.min?.getD 0, values.max?.getD 0)

/-- A unique decimal encoding lets the strict JSON trace checker accept a standard
    JSON parse/stringify round trip, including integer-valued camera coordinates. -/
private def decimal (m : Int) : Nat → JsonNumber
  | 0 => ⟨m, 0⟩
  | e + 1 => if m % 10 == 0 then decimal (m / 10) e else ⟨m, e + 1⟩

def focusPresets (x y : Int × Int) : List Focus :=
  -- Store the midpoint in half-nm units. One half-nm equals 5 × 10⁻⁷ mm.
  let center : Point := ⟨decimal (1500000000 + 5 * (x.1 + x.2)) 7, 100,
                         decimal (300000000 - 5 * (y.1 + y.2)) 7⟩
  let span := max 4000 (2 * max (x.2 - x.1) (y.2 - y.1) + 2000)
  [⟨"installation", "Full installation", ⟨0, 75, 0⟩, 1100⟩,
   ⟨"electronics", "Controller chassis", ⟨-140, 76.5, -150⟩, 600⟩,
   ⟨"optics", "Optical train", ⟨-75, 214, 30⟩, 650⟩,
   ⟨"chamber", "Science cell", ⟨150, 140, 30⟩, 175⟩,
   ⟨"array", "Atom plane", center, decimal span 6⟩]

end Layout

/-- Metric apparatus, cable routes and camera focus frames are part of the replay header. -/
def physicalSystem (p : Program) : Json := Id.run do
  let x := Layout.boundsNm p .x
  let y := Layout.boundsNm p .y
  let worstX := max x.1.natAbs x.2.natAbs
  let worstY := max y.1.natAbs y.2.natAbs
  -- Conservative enclosure of all possible simultaneous coordinates, including empty sites.
  let within := worstX ^ 2 + worstY ^ 2 ≤ 300000 ^ 2
  return Json.mkObj [("unit", toJson "mm"), ("parts", toJson Layout.parts), ("links", toJson Layout.links),
    ("focus", toJson (Layout.focusPresets x y)), ("sources", toJson Layout.sources),
    ("arrayBoundsInsideReferenceField", toJson (decide within)),
    ("note", toJson ("The installation is an illustrative mechanical layout. The sample origin is (150, 100, 30) mm. " ++
      "Local xNm maps to +X and yNm to −Z, with 1000000 nm per mm. " ++
      "Trap rings (0.45 µm radius) and occupied-site crosses (0.50 µm span) annotate coordinates. " ++
      "Link diameters show a 0.6 mm chief-ray guide, an assumed 3 mm RF cable jacket and a 4 mm bus guide. " ++
      "The lenses relay the nominal chief ray. Optical power, beam waist, Bragg steering and window aberrations are uncalibrated. " ++
      "The program supplies timing including acoustic delay independently of cable geometry and the deflector's full-aperture access time."))]

end QControl.Neutral
