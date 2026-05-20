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
	maxModelHuggingFaceIDLen  = 255
	maxModelLicenseLen        = 64
	maxModelDefaultArgsLen    = 8 * 1024 // JSON array of CLI flags — generous for vLLM 20+ args
	maxModelRecommendedGPULen = 1 * 1024 // small JSON object {count, memoryGiB, model}
)

// nameRe enforces DNS-1123 label so Name can serve as a K8s resource
// name in P16 without sanitization. Lowercase letters / digits / hyphen,
// starts + ends with alphanumeric.
var nameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// validRuntimes / validFamilies mirror the closed enums the frontend
// Select restricts to. Server-side check stops a hand-rolled POST from
// inserting an arbitrary string that would never group anywhere on
// the UI (and that the P16 deployment generator wouldn't know how
// to image-select for).
var validRuntimes = map[store.ModelRuntime]bool{
	store.ModelRuntimeVLLM:   true,
	store.ModelRuntimeSGLang: true,
	store.ModelRuntimeTGI:    true,
}

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
	HuggingFaceID  string             `json:"hugging_face_id"`
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
		len(r.HuggingFaceID) > maxModelHuggingFaceIDLen ||
		len(r.License) > maxModelLicenseLen ||
		len(r.DefaultArgs) > maxModelDefaultArgsLen ||
		len(r.RecommendedGPU) > maxModelRecommendedGPULen {
		return CodeInvalidRequest
	}
	if !nameRe.MatchString(r.Name) {
		return CodeInvalidRequest
	}
	// Empty family / runtime are allowed — Create/Update default them.
	if r.Family != "" && !validFamilies[r.Family] {
		return CodeInvalidRequest
	}
	if r.Runtime != "" && !validRuntimes[r.Runtime] {
		return CodeInvalidRequest
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
		HuggingFaceID:  req.HuggingFaceID,
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
		"hugging_face_id": req.HuggingFaceID,
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
