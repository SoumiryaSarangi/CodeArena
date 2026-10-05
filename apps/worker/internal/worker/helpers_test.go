package worker

import (
	"io"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

func stringsReader(s string) io.Reader { return strings.NewReader(s) }

func otelGlobalSetPropagator(p propagation.TextMapPropagator) { otel.SetTextMapPropagator(p) }
