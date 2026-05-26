// Package handler — model catalog (P15).
//
// Global catalog of inference-deployable models. Built-in presets
// (Qwen / DeepSeek / Llama / Mistral / GLM / Yi) seeded on startup
// are mutation-locked; custom rows are CRUD-able. P15 is just the
// catalog — actual deployment to a cluster lands in P16 reading
// the same rows.
package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/togettoyou/kpilot/pkg/server/store"
)

// Field length caps. Three-layer defense (DB varchar / this validator /
// frontend Input maxLength) so an oversized payload can't sneak past
// at any layer. The frontend strings match these byte/rune counts.
const (
	maxModelNameLen           = 63 // DNS-1123 label — Name becomes K8s Deployment.metadata.name in P16
	maxModelDisplayNameLen    = 255
	maxModelDescriptionLen    = 500
	maxModelImageLen          = 512
	maxModelSourceRefLen      = 255 // HF / ModelScope repo id
	maxModelHFEndpointLen     = 512
	maxModelOCIURLLen         = 512
	maxModelLocalPathLen      = 512
	maxModelLicenseLen        = 64
	maxModelDefaultArgsLen    = 8 * 1024 // JSON array of CLI flags — generous for vLLM 20+ args
	maxModelRecommendedGPULen = 1 * 1024 // small JSON object {count, memoryGiB, model}
)

// nameRe enforces DNS-1035 label so Name can serve as a K8s Service
// name in P16 (Service is stricter than DNS-1123: must start with a
// letter, not a digit). Lowercase letter start, then letters / digits
// / hyphen, alphanumeric end. No dots — those are RFC-1123 *subdomain*
// not *label*, and Service names take the label form.
var nameRe = regexp.MustCompile(`^[a-z]([-a-z0-9]*[a-z0-9])?$`)

// validRuntimes / validFamilies mirror the closed enums the frontend
// Select restricts to. Server-side check stops a hand-rolled POST from
// inserting an arbitrary string that would never group anywhere on
// the UI (and that the P16 deployment generator wouldn't know how
// to image-select for).
var validRuntimes = map[store.ModelRuntime]bool{
	store.ModelRuntimeVLLM: true,
}

var validSources = map[store.ModelSource]bool{
	store.ModelSourceHuggingFace: true,
	store.ModelSourceModelScope:  true,
	store.ModelSourceLocalPath:   true,
	store.ModelSourceOCI:         true,
}

// localPathRe matches an absolute container path. Lenient on allowed
// chars (alpha / digit / dot / hyphen / underscore / forward slash);
// must start with `/`. The vLLM CLI accepts any path the container
// can read, so we err on the side of letting through whatever the
// operator intends.
var localPathRe = regexp.MustCompile(`^/[A-Za-z0-9._/-]+$`)

// ociRefRe accepts the common OCI / ORAS reference shapes:
//
//	host[:port]/path[:tag][@sha256:...]
//
// Not exhaustive — operators picking OCI source are expected to
// understand what their registry accepts. Just blocks obvious
// shell-injection / control-char shapes that would make a tag look
// like extra ORAS args.
var ociRefRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]+$`)

var validFamilies = map[store.ModelFamily]bool{
	store.ModelFamilyQwen:     true,
	store.ModelFamilyDeepSeek: true,
	store.ModelFamilyLlama:    true,
	store.ModelFamilyMistral:  true,
	store.ModelFamilyGLM:      true,
	store.ModelFamilyYi:       true,
	store.ModelFamilyPhi:      true,
	store.ModelFamilyGemma:    true,
	store.ModelFamilyKimi:     true,
	store.ModelFamilyCustom:   true,
}

type modelRequest struct {
	Name           string             `json:"name" binding:"required"`
	DisplayName    string             `json:"display_name" binding:"required"`
	Description    string             `json:"description"`
	Family         store.ModelFamily  `json:"family"`
	Runtime        store.ModelRuntime `json:"runtime"`
	Image          string             `json:"image" binding:"required"`
	Source         store.ModelSource  `json:"source"`
	SourceRef      string             `json:"source_ref"`
	HFEndpoint     string             `json:"hf_endpoint"`
	OCIURL         string             `json:"oci_url"`
	LocalPath      string             `json:"local_path"`
	DefaultArgs    string             `json:"default_args"`    // JSON array of strings
	RecommendedGPU string             `json:"recommended_gpu"` // JSON object
	License        string             `json:"license"`
}

// validate runs the length + enum + JSON-shape checks. Returns an
// empty string when valid, otherwise an api error code suitable for
// apiErr. Rune-counts free-text fields (DisplayName, Description) so
// CJK characters don't get rejected earlier than the antd Input UI
// counts them.
func (r *modelRequest) validate() string {
	if len(r.Name) > maxModelNameLen ||
		utf8.RuneCountInString(r.DisplayName) > maxModelDisplayNameLen ||
		utf8.RuneCountInString(r.Description) > maxModelDescriptionLen ||
		len(r.Image) > maxModelImageLen ||
		len(r.SourceRef) > maxModelSourceRefLen ||
		len(r.HFEndpoint) > maxModelHFEndpointLen ||
		len(r.OCIURL) > maxModelOCIURLLen ||
		len(r.LocalPath) > maxModelLocalPathLen ||
		len(r.License) > maxModelLicenseLen ||
		len(r.DefaultArgs) > maxModelDefaultArgsLen ||
		len(r.RecommendedGPU) > maxModelRecommendedGPULen {
		return CodeInvalidRequest
	}
	if !nameRe.MatchString(r.Name) {
		return CodeInvalidRequest
	}
	// Empty family / runtime / source are allowed — Create/Update
	// default them to ("custom" / vllm / huggingface).
	if r.Family != "" && !validFamilies[r.Family] {
		return CodeInvalidRequest
	}
	if r.Runtime != "" && !validRuntimes[r.Runtime] {
		return CodeInvalidRequest
	}
	if r.Source != "" && !validSources[r.Source] {
		return CodeInvalidRequest
	}
	// Per-source field rules. We don't strip "wrong-source" fields
	// when set — the generator simply ignores them — but we DO require
	// the source's primary identifier so an HF row without a repo id
	// can't slip through (vLLM would 404 at startup).
	src := r.Source
	if src == "" {
		src = store.ModelSourceHuggingFace
	}
	switch src {
	case store.ModelSourceHuggingFace, store.ModelSourceModelScope:
		if r.SourceRef == "" {
			return CodeInvalidRequest
		}
	case store.ModelSourceLocalPath:
		if r.LocalPath == "" || !localPathRe.MatchString(r.LocalPath) {
			return CodeInvalidRequest
		}
	case store.ModelSourceOCI:
		if r.OCIURL == "" || !ociRefRe.MatchString(r.OCIURL) {
			return CodeInvalidRequest
		}
	}
	// DefaultArgs must be a JSON array of strings if present. We don't
	// strictly type the elements (e.g. someone may want a flag with a
	// numeric value as a separate element); just confirm it's [string,
	// string, ...]. Empty string is fine.
	if r.DefaultArgs != "" {
		var args []string
		if err := json.Unmarshal([]byte(r.DefaultArgs), &args); err != nil {
			return CodeInvalidRequest
		}
	}
	// RecommendedGPU must be a JSON object if present. Loose shape so
	// we don't have to migrate when we add fields later.
	if r.RecommendedGPU != "" {
		var obj map[string]any
		if err := json.Unmarshal([]byte(r.RecommendedGPU), &obj); err != nil {
			return CodeInvalidRequest
		}
	}
	return ""
}

func ListModels(c *gin.Context) {
	family := c.Query("family")
	runtime := c.Query("runtime")
	models, err := store.ListModels(family, runtime)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusOK, models)
}

func GetModel(c *gin.Context) {
	id, err := parseModelID(c)
	if err != nil {
		return
	}
	m, err := store.GetModelByID(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodeModelNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusOK, m)
}

func CreateModel(c *gin.Context) {
	var req modelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if code := req.validate(); code != "" {
		apiErr(c, http.StatusBadRequest, code)
		return
	}
	if req.Family == "" {
		req.Family = store.ModelFamilyCustom
	}
	if req.Runtime == "" {
		req.Runtime = store.ModelRuntimeVLLM
	}
	if req.Source == "" {
		req.Source = store.ModelSourceHuggingFace
	}
	exists, err := store.ModelNameExists(req.Name)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	if exists {
		apiErr(c, http.StatusConflict, CodeModelNameExists)
		return
	}
	m := &store.Model{
		Name:           req.Name,
		DisplayName:    req.DisplayName,
		Description:    req.Description,
		Family:         req.Family,
		Runtime:        req.Runtime,
		Image:          req.Image,
		Source:         req.Source,
		SourceRef:      req.SourceRef,
		HFEndpoint:     req.HFEndpoint,
		OCIURL:         req.OCIURL,
		LocalPath:      req.LocalPath,
		DefaultArgs:    req.DefaultArgs,
		RecommendedGPU: req.RecommendedGPU,
		License:        req.License,
		IsBuiltin:      false,
	}
	if err := store.CreateModel(m); err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			apiErr(c, http.StatusConflict, CodeModelNameExists)
			return
		}
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusCreated, m)
}

func UpdateModel(c *gin.Context) {
	id, err := parseModelID(c)
	if err != nil {
		return
	}
	existing, err := store.GetModelByID(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodeModelNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}
	if existing.IsBuiltin {
		apiErr(c, http.StatusForbidden, CodeModelBuiltinLocked)
		return
	}
	var req modelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}
	if code := req.validate(); code != "" {
		apiErr(c, http.StatusBadRequest, code)
		return
	}
	if req.Family == "" {
		req.Family = store.ModelFamilyCustom
	}
	if req.Runtime == "" {
		req.Runtime = store.ModelRuntimeVLLM
	}
	if req.Source == "" {
		req.Source = store.ModelSourceHuggingFace
	}
	// Rename collision check — only if Name actually changed, otherwise
	// the count would always include our own row and fire a false 409.
	if req.Name != existing.Name {
		exists, err := store.ModelNameExists(req.Name)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		if exists {
			apiErr(c, http.StatusConflict, CodeModelNameExists)
			return
		}
	}
	updates := map[string]any{
		"name":            req.Name,
		"display_name":    req.DisplayName,
		"description":     req.Description,
		"family":          req.Family,
		"runtime":         req.Runtime,
		"image":           req.Image,
		"source":          req.Source,
		"source_ref":      req.SourceRef,
		"hf_endpoint":     req.HFEndpoint,
		"oci_url":         req.OCIURL,
		"local_path":      req.LocalPath,
		"default_args":    req.DefaultArgs,
		"recommended_gpu": req.RecommendedGPU,
		"license":         req.License,
	}
	if err := store.UpdateModel(existing.ID, updates); err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			apiErr(c, http.StatusConflict, CodeModelNameExists)
			return
		}
		apiErrInternal(c, err)
		return
	}
	// Re-read so the response carries updated_at + any defaulted fields.
	m, err := store.GetModelByID(existing.ID)
	if err != nil {
		apiErrInternal(c, err)
		return
	}
	c.JSON(http.StatusOK, m)
}

func DeleteModel(c *gin.Context) {
	id, err := parseModelID(c)
	if err != nil {
		return
	}
	existing, err := store.GetModelByID(id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErr(c, http.StatusNotFound, CodeModelNotFound)
			return
		}
		apiErrInternal(c, err)
		return
	}
	if existing.IsBuiltin {
		apiErr(c, http.StatusForbidden, CodeModelBuiltinLocked)
		return
	}
	if err := store.DeleteModel(existing.ID); err != nil {
		apiErrInternal(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func parseModelID(c *gin.Context) (uint, error) {
	raw := c.Param("id")
	id, err := strconv.ParseUint(raw, 10, 32)
	if err != nil {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return 0, err
	}
	return uint(id), nil
}
