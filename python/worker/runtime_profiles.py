from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Set

ENV_RUNTIME_FORCE_UNHEALTHY_PROFILES = "RUNTIME_FORCE_UNHEALTHY_PROFILES"
REQUIRED_MODULES_PROBE_TIMEOUT_SEC = 30
REQUIRED_MODULES_PROBE_RETRY_COUNT = 1


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
    def _emit_trace(
        self,
        trace_cb: Optional[Callable[[str, str, str, str], None]],
        stage: str,
        profile_id: str,
        status: str,
        detail: str = "",
    ) -> None:
        if trace_cb is None:
            return
        trace_cb(stage, profile_id, status, detail)

    def _format_probe_timeout_tail(self, exc: subprocess.TimeoutExpired) -> str:
        parts: List[str] = []
        for raw in (exc.stderr, exc.stdout):
            if raw is None:
                continue
            if isinstance(raw, bytes):
                text = raw.decode(errors="ignore")
            else:
                text = str(raw)
            if text.strip():
                parts.append(text.strip())
        merged = " | ".join(parts)
        return merged[-500:] if merged else ""

    def _is_redundant_health_check_for_modules(
        self,
        health_check: Optional[List[str]],
        module_expr: str,
    ) -> bool:
        if not health_check or len(health_check) < 3:
            return False
        if health_check[1] != "-c":
            return False
        script = (health_check[2] or "").strip()
        return script == module_expr.strip()

    def _run_required_modules_probe(
        self,
        executable_path: str,
        profile: RuntimeProfile,
        module_expr: str,
        modules_joined: str,
        checks: List[str],
        trace_cb: Optional[Callable[[str, str, str, str], None]] = None,
    ) -> tuple[Optional[RuntimeHealthResult], bool]:
        self._emit_trace(
            trace_cb,
            "required_modules_probe_start",
            profile.id,
            "start",
            f"modules={modules_joined}",
        )
        retry_after_timeout = False
        for attempt in range(1, REQUIRED_MODULES_PROBE_RETRY_COUNT + 2):
            try:
                probe = subprocess.run(
                    [executable_path, "-c", module_expr],
                    capture_output=True,
                    text=True,
                    timeout=REQUIRED_MODULES_PROBE_TIMEOUT_SEC,
                    cwd=profile.working_directory or None,
                    env=self._build_env(profile, extra_env={}),
                )
                if probe.returncode != 0:
                    stderr_tail = (probe.stderr or probe.stdout or "")[-500:]
                    if retry_after_timeout and attempt == 2:
                        checks.append("required_modules_probe_retry_failed")
                    checks.append(f"required_modules_missing:{modules_joined}:{stderr_tail}")
                    self._emit_trace(
                        trace_cb,
                        "required_modules_probe_end",
                        profile.id,
                        "failed",
                        f"attempt={attempt};reason=nonzero_returncode;detail={stderr_tail}",
                    )
                    return RuntimeHealthResult(healthy=False, checks=checks), False
                if retry_after_timeout and attempt == 2:
                    checks.append("required_modules_probe_retry_success")
                self._emit_trace(
                    trace_cb,
                    "required_modules_probe_end",
                    profile.id,
                    "success",
                    f"attempt={attempt}",
                )
                return None, False
            except subprocess.TimeoutExpired as exc:
                timeout_tail = self._format_probe_timeout_tail(exc)
                if attempt == 1:
                    checks.append(
                        "required_modules_probe_timeout_first_attempt:"
                        f"timeout={REQUIRED_MODULES_PROBE_TIMEOUT_SEC}s"
                    )
                    retry_after_timeout = True
                    continue
                checks.append(
                    "required_modules_probe_retry_timeout:"
                    f"timeout={REQUIRED_MODULES_PROBE_TIMEOUT_SEC}s:{timeout_tail}"
                )
                checks.append("required_modules_probe_degraded_timeout")
                self._emit_trace(
                    trace_cb,
                    "required_modules_probe_end",
                    profile.id,
                    "timeout_degraded",
                    f"attempt={attempt};timeout={REQUIRED_MODULES_PROBE_TIMEOUT_SEC}s;detail={timeout_tail}",
                )
                return None, True
            except Exception as exc:
                if retry_after_timeout and attempt == 2:
                    checks.append("required_modules_probe_retry_failed")
                checks.append(f"required_modules_probe_failed:{exc}")
                self._emit_trace(
                    trace_cb,
                    "required_modules_probe_end",
                    profile.id,
                    "failed",
                    f"attempt={attempt};reason=exception;detail={exc}",
                )
                return RuntimeHealthResult(healthy=False, checks=checks), False
        self._emit_trace(
            trace_cb,
            "required_modules_probe_end",
            profile.id,
            "failed",
            "reason=unknown",
        )
        return None, False

    def check(
        self,
        profile: RuntimeProfile,
        trace_cb: Optional[Callable[[str, str, str, str], None]] = None,
        skip_required_modules_probe: bool = False,
        skip_import_probe: bool = False,
    ) -> RuntimeHealthResult:
        checks: List[str] = []
        forced_profiles = {
            item.strip()
            for item in os.environ.get(ENV_RUNTIME_FORCE_UNHEALTHY_PROFILES, "").split(",")
            if item.strip()
        }
        if profile.id in forced_profiles:
            checks.append("forced_unhealthy_for_test")
            self._emit_trace(trace_cb, "final_runtime_health_decision", profile.id, "failed", "forced_unhealthy_for_test")
            return RuntimeHealthResult(healthy=False, checks=checks)

        self._emit_trace(trace_cb, "executable_probe_start", profile.id, "start", profile.executable)
        executable_path = self._resolve_executable(profile.executable)
        if not executable_path:
            checks.append(f"executable_missing:{profile.executable}")
            self._emit_trace(trace_cb, "executable_probe_end", profile.id, "failed", f"executable_missing:{profile.executable}")
            self._emit_trace(trace_cb, "final_runtime_health_decision", profile.id, "failed", "executable_missing")
            return RuntimeHealthResult(healthy=False, checks=checks)
        self._emit_trace(trace_cb, "executable_probe_end", profile.id, "success", executable_path)

        if profile.required_modules:
            module_expr = "; ".join([f"import {module}" for module in profile.required_modules])
            if skip_required_modules_probe:
                checks.append("required_modules_probe_skipped")
                self._emit_trace(
                    trace_cb,
                    "required_modules_probe_start",
                    profile.id,
                    "skipped",
                    "reason=skip_required_modules_probe",
                )
                self._emit_trace(
                    trace_cb,
                    "required_modules_probe_end",
                    profile.id,
                    "skipped",
                    "reason=skip_required_modules_probe",
                )
                required_modules_probe_degraded = False
            else:
                required_module_failure, required_modules_probe_degraded = self._run_required_modules_probe(
                    executable_path=executable_path,
                    profile=profile,
                    module_expr=module_expr,
                    modules_joined=",".join(profile.required_modules),
                    checks=checks,
                    trace_cb=trace_cb,
                )
                if required_module_failure is not None:
                    self._emit_trace(trace_cb, "final_runtime_health_decision", profile.id, "failed", "|".join(required_module_failure.checks))
                    return required_module_failure
        else:
            module_expr = ""
            required_modules_probe_degraded = False

        if profile.health_check:
            if skip_import_probe:
                checks.append("health_check_probe_skipped")
                self._emit_trace(
                    trace_cb,
                    "import_probe_start",
                    profile.id,
                    "skipped",
                    "reason=skip_import_probe",
                )
                self._emit_trace(
                    trace_cb,
                    "import_probe_end",
                    profile.id,
                    "skipped",
                    "reason=skip_import_probe",
                )
                checks.append("ok_degraded")
                self._emit_trace(trace_cb, "final_runtime_health_decision", profile.id, "success_degraded", "|".join(checks))
                return RuntimeHealthResult(healthy=True, checks=checks)
            self._emit_trace(
                trace_cb,
                "import_probe_start",
                profile.id,
                "start",
                " ".join(profile.health_check),
            )
            if (
                required_modules_probe_degraded
                and self._is_redundant_health_check_for_modules(profile.health_check, module_expr)
            ):
                checks.append("health_check_skipped_after_required_modules_timeout_degraded")
                checks.append("ok_degraded")
                self._emit_trace(
                    trace_cb,
                    "import_probe_end",
                    profile.id,
                    "skipped",
                    "reason=redundant_after_required_modules_timeout_degraded",
                )
                self._emit_trace(trace_cb, "final_runtime_health_decision", profile.id, "success_degraded", "|".join(checks))
                return RuntimeHealthResult(healthy=True, checks=checks)
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
                    self._emit_trace(
                        trace_cb,
                        "import_probe_end",
                        profile.id,
                        "failed",
                        f"reason=nonzero_returncode;detail={stderr_tail}",
                    )
                    self._emit_trace(trace_cb, "final_runtime_health_decision", profile.id, "failed", "|".join(checks))
                    return RuntimeHealthResult(healthy=False, checks=checks)
                self._emit_trace(trace_cb, "import_probe_end", profile.id, "success", "ok")
            except Exception as exc:
                checks.append(f"health_check_exception:{exc}")
                timeout_flag = "timeout" if isinstance(exc, subprocess.TimeoutExpired) else "exception"
                self._emit_trace(
                    trace_cb,
                    "import_probe_end",
                    profile.id,
                    "failed",
                    f"reason={timeout_flag};detail={exc}",
                )
                self._emit_trace(trace_cb, "final_runtime_health_decision", profile.id, "failed", "|".join(checks))
                return RuntimeHealthResult(healthy=False, checks=checks)

        checks.append("ok")
        self._emit_trace(trace_cb, "final_runtime_health_decision", profile.id, "success", "ok")
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

    def resolve(
        self,
        requested_profile_id: str,
        default_profile_id: str,
        trace_cb: Optional[Callable[[str, str, str, str], None]] = None,
        skip_required_modules_probe: bool = False,
        skip_import_probe: bool = False,
    ) -> RuntimeResolution:
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
                health = self._health_checker.check(
                    default_profile,
                    trace_cb=trace_cb,
                    skip_required_modules_probe=skip_required_modules_probe,
                    skip_import_probe=skip_import_probe,
                )
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

            health = self._health_checker.check(
                profile,
                trace_cb=trace_cb,
                skip_required_modules_probe=skip_required_modules_probe,
                skip_import_probe=skip_import_probe,
            )
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
