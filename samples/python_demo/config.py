"""Application configuration: load, merge, defaults."""

from typing import Optional


class AppConfig:
    """Typed configuration container."""

    def __init__(self, **kwargs):
        self.cache_size: int = kwargs.get("cache_size", 128)
        self.default_radius: float = kwargs.get("default_radius", 2.0)
        self.output_format: str = kwargs.get("output_format", "json")
        self.max_objects: int = kwargs.get("max_objects", 1000)
        self.enable_shadows: bool = kwargs.get("enable_shadows", True)
        self.aa_samples: int = kwargs.get("aa_samples", 4)

    @classmethod
    def defaults(cls) -> "AppConfig":
        return cls()

    def validate(self) -> bool:
        if self.cache_size < 1:
            raise ValueError("cache_size must be >= 1")
        if self.default_radius <= 0:
            raise ValueError("default_radius must be positive")
        if self.output_format not in ("json", "binary", "text"):
            raise ValueError(f"Unknown format: {self.output_format}")
        return True


def load_config(path: str) -> AppConfig:
    """Load config from a YAML file (stub: returns defaults)."""
    # In a real app this would parse the file.
    return _parse_yaml_stub(path)


def merge_configs(base: AppConfig, overlay: AppConfig) -> AppConfig:
    """Merge two configs, overlay wins on conflicts."""
    merged = AppConfig()
    for field in ("cache_size", "default_radius", "output_format",
                  "max_objects", "enable_shadows", "aa_samples"):
        base_val = getattr(base, field)
        overlay_val = getattr(overlay, field)
        default_val = getattr(AppConfig.defaults(), field)
        setattr(merged, field, overlay_val if overlay_val != default_val else base_val)
    return merged


def _parse_yaml_stub(path: str) -> AppConfig:
    """Stub YAML parser — returns defaults."""
    return AppConfig()
