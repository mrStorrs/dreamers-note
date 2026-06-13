from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ValidationError:
    reason: str
    message: str
    path: str = ""


@dataclass(frozen=True)
class ValidationResult:
    errors: tuple[ValidationError, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.errors


def validation_error(reason: str, message: str, path: str = "") -> ValidationError:
    return ValidationError(reason=reason, message=message, path=path)
