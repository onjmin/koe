"""Shared PyTorch accelerator selection for the intonation trainers."""

from __future__ import annotations

import torch


def resolve_device(requested: str) -> torch.device:
    """Resolve ``auto`` or validate an explicitly requested torch device."""

    name = requested.strip().lower()
    if name == "auto":
        if torch.cuda.is_available():
            return torch.device("cuda")
        xpu = getattr(torch, "xpu", None)
        if xpu is not None and xpu.is_available():
            return torch.device("xpu")
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return torch.device("mps")
        return torch.device("cpu")

    try:
        device = torch.device(name)
    except (RuntimeError, ValueError) as error:
        raise ValueError(f"invalid PyTorch device {requested!r}") from error
    if device.type == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA was requested, but this PyTorch installation cannot use CUDA")
    if device.type == "xpu":
        xpu = getattr(torch, "xpu", None)
        if xpu is None or not xpu.is_available():
            raise ValueError("XPU was requested, but this PyTorch installation cannot use XPU")
    if device.type == "mps":
        mps = getattr(torch.backends, "mps", None)
        if mps is None or not mps.is_available():
            raise ValueError("MPS was requested, but this PyTorch installation cannot use MPS")
    return device


def device_description(device: torch.device) -> str:
    """Return a useful, stable label for logs and exported metadata."""

    if device.type == "cuda":
        index = device.index if device.index is not None else torch.cuda.current_device()
        return f"cuda:{index} ({torch.cuda.get_device_name(index)})"
    if device.type == "xpu":
        index = device.index if device.index is not None else torch.xpu.current_device()
        name = torch.xpu.get_device_name(index) if hasattr(torch.xpu, "get_device_name") else "XPU"
        return f"xpu:{index} ({name})"
    return str(device)


def move_batch(device: torch.device, *tensors: torch.Tensor) -> tuple[torch.Tensor, ...]:
    """Move one fully assembled CPU batch to the accelerator in one operation."""

    if device.type == "cpu":
        return tensors
    return tuple(tensor.to(device=device, non_blocking=True) for tensor in tensors)
