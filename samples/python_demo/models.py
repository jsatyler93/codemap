"""Scene graph models: Scene, SceneObject, Material, Light."""

from typing import List, Optional, Tuple
from .geometry import BoundingBox


class Material:
    """Surface material with PBR-like properties."""

    def __init__(self, name: str, albedo: Tuple[float, ...],
                 roughness: float = 0.5, transparency: float = 0.0,
                 ior: float = 1.0):
        self.name = name
        self.albedo = albedo
        self.roughness = roughness
        self.transparency = transparency
        self.ior = ior

    def is_transparent(self) -> bool:
        return self.transparency > 0.01

    def effective_color(self, light_color: Tuple[float, ...]) -> Tuple[float, ...]:
        return tuple(a * l for a, l in zip(self.albedo, light_color))


class Light:
    """Scene light source."""

    def __init__(self, kind: str, intensity: float,
                 color: Tuple[float, ...] = (1, 1, 1),
                 direction=None, position=None):
        self.kind = kind
        self.intensity = intensity
        self.color = color
        self.direction = direction
        self.position = position

    def attenuated_intensity(self, distance: float) -> float:
        if self.kind == "directional":
            return self.intensity
        return self.intensity / max(1.0, distance ** 2)


class SceneObject:
    """An object in the scene: geometry + material + transform."""

    def __init__(self, name: str, geometry, material: Material,
                 transform=None):
        self.name = name
        self.geometry = geometry
        self.material = material
        self.transform = transform
        self.children: List["SceneObject"] = []

    def add_child(self, child: "SceneObject"):
        self.children.append(child)

    def flatten(self) -> List["SceneObject"]:
        result = [self]
        for c in self.children:
            result.extend(c.flatten())
        return result


class Scene:
    """Top-level scene container."""

    def __init__(self, objects: List[SceneObject] = None,
                 lights: List[Light] = None):
        self.objects = objects or []
        self.lights = lights or []
        self.bounds: Optional[BoundingBox] = None

    def compute_bounds(self):
        boxes = []
        for obj in self.objects:
            if hasattr(obj.geometry, "bounding_box"):
                boxes.append(obj.geometry.bounding_box())
        if boxes:
            merged = boxes[0]
            for b in boxes[1:]:
                merged = merged.merge(b)
            self.bounds = merged

    def find_object(self, name: str) -> Optional[SceneObject]:
        for obj in self.objects:
            if obj.name == name:
                return obj
            for child in obj.flatten():
                if child.name == name:
                    return child
        return None


def load_scene_from_dict(data: dict) -> Scene:
    """Deserialize a scene from a plain dict."""
    objects = []
    for obj_data in data.get("objects", []):
        mat = Material(
            name=obj_data.get("material", "default"),
            albedo=tuple(obj_data.get("albedo", (0.5, 0.5, 0.5))),
        )
        so = SceneObject(name=obj_data["name"], geometry=None, material=mat)
        objects.append(so)
    lights = []
    for l_data in data.get("lights", []):
        lights.append(Light(
            kind=l_data.get("kind", "point"),
            intensity=l_data.get("intensity", 1.0),
        ))
    scene = Scene(objects=objects, lights=lights)
    scene.compute_bounds()
    return scene


def validate_scene(scene: Scene):
    """Raise if the scene is structurally invalid."""
    if not scene.objects:
        raise ValueError("Scene has no objects")
    for obj in scene.objects:
        if obj.material is None:
            raise ValueError(f"Object '{obj.name}' missing material")
    for light in scene.lights:
        if light.intensity < 0:
            raise ValueError("Negative light intensity")
