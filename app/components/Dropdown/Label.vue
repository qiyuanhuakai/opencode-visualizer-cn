<template>
  <div class="ui-dropdown-label">
    <span class="ui-dropdown-label-text">
      <slot />
    </span>
    <span v-if="$slots.action" class="ui-dropdown-label-action">
      <slot name="action" />
    </span>
  </div>
</template>

<style scoped>
.ui-dropdown-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px 2px 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: #64748b;
  user-select: none;
}

.ui-dropdown-label-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-dropdown-label-action {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}
</style>
