import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterOperatorDef {
  value: string;
  label: string;
  multi?: boolean;
}

export interface FilterFieldDef {
  id: string;
  label: string;
  icon?: ReactNode;
  operators: FilterOperatorDef[];
  options?: FilterOption[];
  loadOptions?: (query: string) => Promise<FilterOption[]>;
}

export interface Filter {
  id: string;
  field: string;
  operator: string;
  values: string[];
}

export interface FilterBarProps {
  fields: FilterFieldDef[];
  value: Filter[];
  onChange: (filters: Filter[]) => void;
  addLabel?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

const control =
  'h-8 rounded-md border bg-background px-2 text-[0.6875rem] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus:border-ring focus:ring-1 focus:ring-ring disabled:pointer-events-none disabled:opacity-40';

function useOptions(field: FilterFieldDef | undefined) {
  const [options, setOptions] = useState<FilterOption[]>(field?.options ?? []);
  useEffect(() => {
    if (!field) return;
    if (field.options) {
      setOptions(field.options);
      return;
    }
    let cancelled = false;
    void field.loadOptions?.('').then((loaded) => {
      if (!cancelled) setOptions(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [field]);
  return options;
}

function FilterToken({
  filter,
  field,
  onChange,
  onRemove,
  disabled,
}: {
  filter: Filter;
  field: FilterFieldDef;
  onChange: (next: Filter) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const options = useOptions(field);
  const operator = field.operators.find((item) => item.value === filter.operator) ?? field.operators[0];
  return (
    <div className="inline-flex items-center gap-1 rounded-md border bg-muted/40 p-0.5">
      <span className="inline-flex items-center gap-1 px-1.5 text-[0.6875rem] font-medium">
        {field.icon}
        {field.label}
      </span>
      <select
        aria-label={`${field.label} operator`}
        className={control}
        disabled={disabled}
        value={operator.value}
        onChange={(event) => onChange({ ...filter, operator: event.target.value })}
      >
        {field.operators.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
      <select
        aria-label={`${field.label} values`}
        className={`${control} max-w-[14rem]`}
        disabled={disabled}
        multiple={Boolean(operator.multi)}
        size={operator.multi ? 1 : undefined}
        value={operator.multi ? filter.values : (filter.values[0] ?? '')}
        onChange={(event) =>
          onChange({
            ...filter,
            values: operator.multi
              ? Array.from(event.target.selectedOptions, (option) => option.value)
              : event.target.value
                ? [event.target.value]
                : [],
          })
        }
      >
        {operator.multi ? null : <option value="">Any</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <button type="button" aria-label={`Remove ${field.label} filter`} className={`${control} w-8 px-0`} disabled={disabled} onClick={onRemove}>
        <X className="mx-auto size-3.5" />
      </button>
    </div>
  );
}

export function FilterBar({
  fields,
  value,
  onChange,
  addLabel = 'Add filter',
  emptyLabel = 'No filters',
  disabled,
  className = '',
  'aria-label': ariaLabel,
}: FilterBarProps) {
  return (
    <div role="group" aria-label={ariaLabel} className={`flex flex-wrap items-center gap-2 ${className}`}>
      {value.length === 0 ? <span className="text-[0.6875rem] text-muted-foreground">{emptyLabel}</span> : null}
      {value.map((filter) => {
        const field = fields.find((item) => item.id === filter.field);
        if (!field) return null;
        return (
          <FilterToken
            key={filter.id}
            filter={filter}
            field={field}
            disabled={disabled}
            onChange={(next) => onChange(value.map((item) => (item.id === filter.id ? next : item)))}
            onRemove={() => onChange(value.filter((item) => item.id !== filter.id))}
          />
        );
      })}
      <select
        aria-label={addLabel}
        className={control}
        disabled={disabled || fields.length === 0}
        value=""
        onChange={(event) => {
          const field = fields.find((item) => item.id === event.target.value);
          if (!field) return;
          onChange([
            ...value,
            { id: `${field.id}-${Date.now()}`, field: field.id, operator: field.operators[0].value, values: [] },
          ]);
        }}
      >
        <option value="" disabled>
          {addLabel}
        </option>
        {fields.map((field) => (
          <option key={field.id} value={field.id}>
            {field.label}
          </option>
        ))}
      </select>
    </div>
  );
}
