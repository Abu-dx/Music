from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

ENV_RUNTIME_FORCE_UNHEALTHY_PROFILES = "RUNTIME_FORCE_UNHEALTHY_PROFILES"


@dataclass
class RuntimeProfile:
    id: str
    model_id: str
    executable: str
    environment_root: str = ""
    working_directory: Optional[str] = None
    env: Dict[str, str] = field(default_factory=dict)
    required_modules: List[str] = field(default_factory=list)
    health_check: Optional[List[str]] = None
    model_paths: Dict[str, str] = field(default_factory=dict)
    device_preference: Optional[str] = None
    isolation_mode: str = "subprocess"
    default_timeout_sec: int = 600
    allow_fallback: bool = True
    fallback_profile_id: Optional[str] = None
    admission_approved: bool = True


@dataclass
class RuntimeHealthResult:
    healthy: bool
    checks: List[str]


@dataclass
class RuntimeResolution:
    requested_profile_id: str
    actual_profile_id: str
    profile: RuntimeProfile
    fallback_reason: Optional[str]
    health: RuntimeHealthResult


class RuntimeProfileRegistry:
    def __init__(self, profiles: List[RuntimeProfile]):
        self._profiles: Dict[str, RuntimeProfile] = {}
        duplicate_ids: Set[str] = set()
        for profile in profiles:
            if profile.id in self._profiles:
                duplicate_ids.add(profile.id)
            self._profiles[profile.id] = profile
        if duplicate_ids:
            joined = ",".join(sorted(duplicate_ids))
            raise ValueError(f"runtime profile duplicated id(s): {joined}")
        self._validate_or_raise()

    def get(self, profile_id: str) -> Optional[RuntimeProfile]:
        return self._profiles.get(profile_id)

    def list(self) -> List[RuntimeProfile]:
        return list(self._profiles.values())

    def validate_for_command(self, profile: RuntimeProfile, command_name: str, allowed_model_ids: Set[str]) -> None:
        if not profile.admission_approved:
            raise RuntimeError(f"runtime profile not admitted: {profile.id}")
        if profile.model_id not in allowed_model_ids:
            allowed = ",".join(sorted(allowed_model_ids))
            raise RuntimeError(
                f"runtime profile model not allowed for command {command_name}: "
                f"profile={profile.id}, model={profile.model_id}, allowed={allowed}"
            )

    def _validate_or_raise(self) -> None:
        if not self._profiles:
            raise ValueError("runtime profile registry is empty")

        subprocess_roots: Dict[str, str] = {}
        profile_ids = set(self._profiles.keys())

        for profile in self._profiles.values():
            if not profile.id or not profile.id.strip():
                raise ValueError("runtime profile id cannot be empty")
            if not profile.model_id or not profile.model_id.strip():
                raise ValueError(f"runtime profile model_id missing: {profile.id}")
            if profile.fallback_profile_id and profile.fallback_profile_id not in profile_ids:
                raise ValueError(
                    f"runtime profile fallback missing: profile={profile.id}, "
                    f"fallback={profile.fallback_profile_id}"
                )

            if profile.isolation_mode != "subprocess":
                continue

            executable = (profile.executable or "").strip()
            if not executable:
                raise ValueError(f"runtime profile executable missing: {profile.id}")
            if not profile.health_check or len(profile.health_check) == 0:
                raise ValueError(f"runtime profile health_check missing: {profile.id}")

            normalized_root = self._normalize_environment_root(profile.environment_root)
            if not normalized_root:
                raise ValueError(f"runtime profile environment_root missing: {profile.id}")
            profile.environment_root = normalized_root

            existing = subprocess_roots.get(normalized_root)
            if existing:
                raise ValueError(
                    f"runtime profile environment_root duplicated: root={normalized_root}, "
                    f"profiles={existing},{profile.id}"
                )
            subprocess_roots[normalized_root] = profile.id

    def _normalize_environment_root(self, value: str) -> str:
        raw = (value or "").strip()
        if not raw:
            return ""
        if raw.lower().startswith("inprocess://"):
            return raw
        return os.path.normcase(os.path.realpath(os.path.abspath(raw)))


class RuntimeHealthChecker:
    def check(self, profile: RuntimeProfile) -> RuntimeHealthResult:
        checks: List[str] = []
        forced_profiles = {
            item.strip()
            for item in os.environ.get(ENV_RUNTIME_FORCE_UNHEALTHY_PROFILES, "").split(",")
            if item.strip()
        }
        if profile.id in forced_profiles:
            checks.append("forced_unhealthy_for_test")
            return RuntimeHealthResult(healthy=False, checks=checks)

        executable_path = self._resolve_executable(profile.executable)
        if not executable_path:
            checks.append(f"executable_missing:{profile.executable}")
            return RuntimeHealthResult(healthy=False, checks=checks)

        if profile.required_modules:
            module_expr = "; ".join([f"import {module}" for module in profile.required_modules])
            try:
                probe = subprocess.run(
                    [executable_path, "-c", module_expr],
                    capture_output=True,
                    text=True,
                    timeout=12,
                    cwd=profile.working_directory or None,
                    env=self._build_env(profile, extra_env={}),
                )
                if probe.returncode != 0:
                    stderr_tail = (probe.stderr or probe.stdout or "")[-500:]
                    checks.append(
                        f"required_modules_missing:{','.join(profile.required_modules)}:{stderr_tail}"
                    )
                    return RuntimeHealthResult(healthy=False, checks=checks)
            except Exception as exc:
                checks.append(f"required_modules_probe_failed:{exc}")
                return RuntimeHealthResult(healthy=False, checks=checks)

        if profile.health_check:
            try:
                probe = subprocess.run(
                    profile.health_check,
                    capture_output=True,
                    text=True,
                    timeout=12,
                    cwd=profile.working_directory or None,
                    env=self._build_env(profile, extra_env={}),
                )
                if probe.returncode != 0:
                    stderr_tail = (probe.stderr or probe.stdout or "")[-500:]
                    checks.append(f"health_check_failed:{stderr_tail}")
                    return RuntimeHealthResult(healthy=False, checks=checks)
            except Exception as exc:
                checks.append(f"health_check_exception:{exc}")
                return RuntimeHealthResult(healthy=False, checks=checks)

        checks.append("ok")
        return RuntimeHealthResult(healthy=True, checks=checks)

    def _resolve_executable(self, executable: str) -> Optional[str]:
        if not executable:
            return None
        if os.path.isfile(executable):
            return executable
        return shutil.which(executable)

    def _build_env(self, profile: RuntimeProfile, extra_env: Dict[str, str]) -> Dict[str, str]:
        env = dict(os.environ)
        env.update(profile.env)
        env.update(extra_env)
        return env


class RuntimeResolver:
    def __init__(self, registry: RuntimeProfileRegistry, health_checker: RuntimeHealthChecker):
        self._registry = registry
        self._health_checker = health_checker

    def resolve(self, requested_profile_id: str, default_profile_id: str) -> RuntimeResolution:
        requested = (requested_profile_id or "").strip() or default_profile_id
        current = requested
        visited: set[str] = set()
        fallback_reason: Optional[str] = None

        while True:
            if current in visited:
                fallback = fallback_reason or f"runtime_cycle_detected:{current}"
                default_profile = self._registry.get(default_profile_id)
                if default_profile is None:
                    raise RuntimeError(f"default runtime profile missing: {default_profile_id}")
                health = self._health_checker.check(default_profile)
                return RuntimeResolution(
                    requested_profile_id=requested,
                    actual_profile_id=default_profile_id,
                    profile=default_profile,
                    fallback_reason=fallback,
                    health=health,
                )
            visited.add(current)

            profile = self._registry.get(current)
            if profile is None:
                fallback_reason = fallback_reason or f"profile_not_found:{current}"
                if current == default_profile_id:
                    raise RuntimeError(f"default runtime profile missing: {default_profile_id}")
                current = default_profile_id
                continue

            health = self._health_checker.check(profile)
            if health.healthy:
                return RuntimeResolution(
                    requested_profile_id=requested,
                    actual_profile_id=profile.id,
                    profile=profile,
                    fallback_reason=fallback_reason,
                    health=health,
                )

            next_profile = profile.fallback_profile_id
            if not next_profile and profile.allow_fallback and profile.id != default_profile_id:
                next_profile = default_profile_id
            fallback_reason = fallback_reason or f"health_unavailable:{profile.id}:{'|'.join(health.checks)}"
            if not next_profile:
                return RuntimeResolution(
                    requested_profile_id=requested,
                    actual_profile_id=profile.id,
                    profile=profile,
                    fallback_reason=fallback_reason,
                    health=health,
                )
            current = next_profile


@dataclass
class ExecutionRequest:
    args: List[str]
    timeout_sec: Optional[int] = None
    shell: bool = False
    prepend_executable: bool = True
    extra_env: Dict[str, str] = field(default_factory=dict)
    capture_output: bool = True
    text: bool = True


@dataclass
class ExecutionResult:
    command_display: str
    returncode: int
    stdout: str
    stderr: str
    elapsed_ms: int


class ProcessLauncher:
    def launch(self, profile: RuntimeProfile, request: ExecutionRequest) -> ExecutionResult:
        env = dict(os.environ)
        env.update(profile.env)
        env.update(request.extra_env)

        command = list(request.args)
        if request.prepend_executable and not request.shell:
            command = [profile.executable] + command
        if request.shell:
            cmd_obj: str | List[str]
            cmd_obj = command[0] if len(command) == 1 else " ".join(shlex.quote(x) for x in command)
        else:
            cmd_obj = command

        display = (
            cmd_obj
            if isinstance(cmd_obj, str)
            else " ".join(shlex.quote(x) for x in cmd_obj)
        )
        started = time.time()
        timeout_sec = request.timeout_sec if request.timeout_sec and request.timeout_sec > 0 else profile.default_timeout_sec
        proc = subprocess.run(
            cmd_obj,
            capture_output=request.capture_output,
            text=request.text,
            timeout=timeout_sec,
            shell=request.shell,
            cwd=profile.working_directory or None,
            env=env,
        )
        elapsed_ms = int((time.time() - started) * 1000)
        return ExecutionResult(
            command_display=display,
            returncode=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            elapsed_ms=elapsed_ms,
        )
