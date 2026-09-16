/**
 * Deterministic External-first Chief routing.  This module deliberately knows
 * nothing about Chief prompts or business decisions; it only chooses the
 * prepared External route, bounded recovery, or the Host fallback and emits a
 * durable, observable route record through the supplied callback.
 */
export async function routeChiefCall(options) {
  const startedAt = Date.now();
  const route = {
    requested_role: options.requestedRole ?? "chief",
    selected_route: null,
    external_warm: { attempted: false, success: false },
    external_recovery: { attempted: false, success: false },
    host_fallback_reason: null,
    host_route: null,
    final_chief_identity: null,
    duration: null,
    failure_code: null,
  };
  const persist = async (extra = {}) => {
    route.duration = Date.now() - startedAt;
    await options.record?.({ ...route, ...extra });
  };
  const invokeHost = async (hostError) => {
    try {
      const result = await options.host(hostError);
      await persist({ result: "HOST_FALLBACK" });
      return result;
    } catch (error) {
      await persist({
        result: "HOST_FAILURE",
        host_failure_code: error?.code ?? "HOST_CHIEF_FAILURE",
        host_failure_message:
          error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  let preflight;
  try {
    preflight = await (options.warmPreflight?.() ?? { ok: true });
  } catch (error) {
    preflight = {
      ok: false,
      code: error?.code ?? "EXTERNAL_WARM_PREFLIGHT_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  route.external_warm.attempted = true;
  route.external_warm.success = preflight.ok === true;
  if (preflight.ok !== true) {
    route.external_warm.code = preflight.code ?? "EXTERNAL_WARM_FAILED";
    if (options.recover) {
      route.external_recovery.attempted = true;
      let recovered;
      try {
        recovered = await options.recover(preflight);
      } catch (error) {
        recovered = {
          ok: false,
          code: error?.code ?? "EXTERNAL_RECOVERY_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      route.external_recovery.success = recovered?.ok === true;
      if (route.external_recovery.success) {
        route.selected_route = "EXTERNAL_RECOVERY";
      } else {
        route.external_recovery.code =
          recovered?.code ?? "EXTERNAL_RECOVERY_FAILED";
      }
    } else {
      throw Object.assign(
        new Error(
          "CHIEF_ROUTER_RECOVERY_REQUIRED: Warm External failure cannot bypass recovery"
        ),
        { code: "CHIEF_ROUTER_RECOVERY_REQUIRED" }
      );
    }
    if (route.selected_route !== "EXTERNAL_RECOVERY") {
      route.selected_route = "HOST_CHIEF";
      route.host_route = "HOST_SOL_HIGH";
      route.host_fallback_reason =
        route.external_recovery.code ?? route.external_warm.code;
      route.final_chief_identity = "host";
      return invokeHost();
    }
  } else {
    route.selected_route = "EXTERNAL_WARM";
  }
  try {
    const result = await options.external({ route });
    route.final_chief_identity = "external";
    await persist({ result: "EXTERNAL_SUCCESS" });
    return result;
  } catch (error) {
    route.failure_code = error?.code ?? "EXTERNAL_CHIEF_FAILURE";
    route.host_fallback_reason =
      error instanceof Error ? error.message : String(error);
    if (options.recover) {
      route.external_recovery.attempted = true;
      let recovered;
      try {
        recovered = await options.recover(error, { transportFailure: true });
      } catch (recoveryError) {
        recovered = {
          ok: false,
          code: recoveryError?.code ?? "EXTERNAL_RECOVERY_FAILED",
          message:
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError),
        };
      }
      route.external_recovery.success = recovered?.ok === true;
      if (route.external_recovery.success) {
        route.selected_route = "EXTERNAL_RECOVERY";
        try {
          const result = await options.external({
            route,
            recovery: true,
          });
          route.final_chief_identity = "external";
          await persist({ result: "EXTERNAL_RECOVERY_SUCCESS" });
          return result;
        } catch (retryError) {
          route.failure_code = retryError?.code ?? "EXTERNAL_CHIEF_FAILURE";
          route.host_fallback_reason =
            retryError instanceof Error
              ? retryError.message
              : String(retryError);
        }
      } else {
        route.external_recovery.code =
          recovered?.code ?? "EXTERNAL_RECOVERY_FAILED";
      }
    } else {
      throw Object.assign(
        new Error(
          "CHIEF_ROUTER_RECOVERY_REQUIRED: External transport failure cannot bypass recovery"
        ),
        { code: "CHIEF_ROUTER_RECOVERY_REQUIRED" }
      );
    }
    route.selected_route = "HOST_CHIEF";
    route.host_route = "HOST_SOL_HIGH";
    route.final_chief_identity = "host";
    return invokeHost(error);
  }
}
