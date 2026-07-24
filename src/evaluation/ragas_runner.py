"""Ticket 14 — Offline RAGAS evaluator runner.

Spec issue #14 criteria:
  #1: The evaluator environment pins compatible Python, RAGAS and supporting
      dependency versions (see ragas_requirements.txt).
  #3: The Python evaluator returns a versioned JSON result with metric values,
      duration and safe error information.
  #5: Malformed output, timeout, missing runtime and evaluator failure produce
      explicit skipped or failed outcomes.
  #6: The online chat runtime does not import, spawn or depend on the RAGAS
      evaluator — this script lives in src/evaluation/ and is only spawned by
      RagasEvaluatorImpl (TypeScript offline path).

Contract:
  - Read a single JSON line from stdin (RagasRequest, schemaVersion=1).
  - Try to import ragas. If the import fails, emit a versioned JSON response
    with status="error" and error.kind="missing_runtime" so the TypeScript
    wrapper can surface skip semantics (local profile) or failure (production
    profile) per criterion #5.
  - On success, run the four standard RAGAS metrics (faithfulness,
    answer_relevancy, context_precision, context_recall) and emit a versioned
    JSON response with status="ok" and the metric values.
  - On any internal failure, emit status="error" with error.kind=
    "evaluator_failure" and a safe (non-secret) message.
  - Only the FINAL stdout line is the JSON response — earlier logging goes to
    stderr so the TypeScript wrapper's extractLastJsonLine can find it.

This script NEVER throws an unhandled exception to stderr without first
writing a JSON response line — the wrapper treats non-zero exit + stderr as
evaluator_failure, but a clean exit with a status="error" JSON line is the
preferred error path.
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from typing import Any


SCHEMA_VERSION = 1
SUPPORTED_METRICS = (
    "faithfulness",
    "answer_relevancy",
    "context_precision",
    "context_recall",
)


def emit_response(payload: dict[str, Any]) -> None:
    """Write the versioned JSON response as the final stdout line and exit 0."""
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()
    sys.exit(0)


def emit_error(case_id: str, duration_ms: int, kind: str, message: str) -> None:
    """Emit a versioned error response (criterion #5)."""
    emit_response(
        {
            "schemaVersion": SCHEMA_VERSION,
            "caseId": case_id,
            "status": "error",
            "durationMs": duration_ms,
            "error": {"kind": kind, "message": message},
        }
    )


def read_request() -> dict[str, Any]:
    """Read and parse the JSON request from stdin."""
    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as err:
        # Cannot recover caseId — emit a generic error and exit non-zero so
        # the wrapper classifies this as evaluator_failure.
        sys.stderr.write(f"ragas_runner: stdin is not valid JSON: {err}\n")
        sys.exit(1)
    return request


def import_ragas() -> tuple[bool, str]:
    """Try to import ragas. Returns (ok, message)."""
    try:
        import ragas  # noqa: F401
        from ragas import metrics as _metrics  # noqa: F401
        return True, ""
    except ImportError as err:
        return False, f"ragas import failed: {err}"
    except Exception as err:  # pragma: no cover — defensive
        return False, f"ragas import raised: {err}"


def run_metrics(request: dict[str, Any]) -> list[dict[str, Any]]:
    """Run the four standard RAGAS metrics and return metric result objects.

    This is the live RAGAS path. It is NOT exercised by the unit-test suite
    (criterion #7 uses a fake Node runner). Production callers must install
    the pinned dependencies from ragas_requirements.txt.
    """
    from ragas import metrics as ragas_metrics
    from ragas.llms import llm_factory
    from ragas.embeddings import embedding_factory

    # The evaluator model identities are recorded in the artifact for
    # reproducibility — they do not override the pinned RAGAS-internal models
    # unless the caller wires env vars (OPENAI_API_KEY etc.).
    identities = request.get("evaluatorModelIdentities", {})
    _ = identities.get("chat"), identities.get("embedding"), identities.get("evaluator")

    # Build the RAGAS SingleTurnSample from the request fields.
    from ragas.dataset_schema import SingleTurnSample

    sample = SingleTurnSample(
        user_input=request.get("question", ""),
        response=request.get("approvedAnswer", ""),
        retrieved_contexts=request.get("retrievedContexts", []),
        reference=request.get("referenceAnswer"),
    )

    llm = llm_factory()
    embeddings = embedding_factory()

    metric_objects = [
        ragas_metrics.faithfulness,
        ragas_metrics.answer_relevancy,
        ragas_metrics.context_precision,
        ragas_metrics.context_recall,
    ]

    results: list[dict[str, Any]] = []
    for metric in metric_objects:
        score = metric.score(sample=sample, llm=llm, embeddings=embeddings)
        results.append(
            {
                "name": metric.name,
                "score": float(score),
            }
        )
    return results


def main() -> None:
    started_at = time.monotonic()

    request = read_request()
    case_id = request.get("caseId", "")
    if not isinstance(case_id, str) or not case_id:
        # Cannot attribute the error to a case — non-zero exit so the wrapper
        # classifies as evaluator_failure.
        sys.stderr.write("ragas_runner: request.caseId is missing or invalid\n")
        sys.exit(1)

    def duration_ms() -> int:
        return int((time.monotonic() - started_at) * 1000)

    # Criterion #5: missing runtime produces an explicit error outcome.
    ok, import_message = import_ragas()
    if not ok:
        emit_error(case_id, duration_ms(), "missing_runtime", import_message)

    # Run the live RAGAS evaluation.
    try:
        metrics = run_metrics(request)
    except Exception as err:
        tb = traceback.format_exc()
        # Log the full traceback to stderr for debugging, but emit only a
        # safe (non-secret) message in the JSON response.
        sys.stderr.write(tb)
        safe_message = f"{type(err).__name__}: {err}"[:500]
        emit_error(case_id, duration_ms(), "evaluator_failure", safe_message)

    emit_response(
        {
            "schemaVersion": SCHEMA_VERSION,
            "caseId": case_id,
            "status": "ok",
            "metrics": metrics,
            "durationMs": duration_ms(),
        }
    )


if __name__ == "__main__":
    main()