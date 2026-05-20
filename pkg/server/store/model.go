package store

import (
	"time"

	"gorm.io/gorm"
)

// ─── Model (catalog) ───────────────────────────────────────────────────────

func CreateModel(m *Model) error {
	return DB.Create(m).Error
}

func GetModelByID(id uint) (*Model, error) {
	var m Model
	if err := DB.First(&m, id).Error; err != nil {
		return nil, err
	}
	return &m, nil
}

func GetModelByName(name string) (*Model, error) {
	var m Model
	if err := DB.Where("name = ?", name).First(&m).Error; err != nil {
		return nil, err
	}
	return &m, nil
}

// ListModels returns every row, ordered to read top-to-bottom the way
// the catalog UI groups: built-ins first (so curated presets stay
// above user-added rows), then by family for natural grouping, then
// by sort_order within a family so seed.go can put 7B before 14B
// before 72B without name-sort flipping them. Name is the final
// tie-breaker for stability.
//
// Optional filter args are AND-ed. An empty string skips the filter.
func ListModels(family, runtime string) ([]Model, error) {
	var models []Model
	q := DB.Model(&Model{})
	if family != "" {
		q = q.Where("family = ?", family)
	}
	if runtime != "" {
		q = q.Where("runtime = ?", runtime)
	}
	if err := q.Order("is_builtin desc, family, sort_order, name").Find(&models).Error; err != nil {
		return nil, err
	}
	return models, nil
}

// UpdateModel updates the user-editable fields. Caller checks
// is_builtin upstream — built-in rows reject the request at the
// handler layer, this helper doesn't enforce it.
func UpdateModel(id uint, updates map[string]any) error {
	updates["updated_at"] = time.Now()
	return DB.Model(&Model{}).Where("id = ?", id).Updates(updates).Error
}

func DeleteModel(id uint) error {
	return DB.Delete(&Model{}, id).Error
}

func ModelNameExists(name string) (bool, error) {
	var count int64
	if err := DB.Model(&Model{}).Where("name = ?", name).Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

var ErrModelNotFound = gorm.ErrRecordNotFound
