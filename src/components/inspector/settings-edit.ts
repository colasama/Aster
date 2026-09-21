export type SettingsRecipe<T> = (current: T, index: number) => T;
export type SettingsEdit<T> = (value: T, recipe?: SettingsRecipe<T>) => void;

/** Keep the existing single-value callbacks while forwarding field edits across a selection. */
export function settingsEdit<T>(current: T, onChange: SettingsEdit<T>, count = 1) {
  return (recipe: SettingsRecipe<T>) => {
    const value = recipe(current, 0);
    if (count > 1) onChange(value, recipe);
    else onChange(value);
  };
}
