export interface BaseField {
  label: string;
  key: string;
  title?: string;
  modifier?: string;
}

export interface NumberField extends BaseField {
  type: 'number';
}
export interface CheckboxField extends BaseField {
  type: 'checkbox';
}
export interface SelectField extends BaseField {
  type: 'select';
  options: ReadonlyArray<[string, string]>;
}
export interface TextField extends BaseField {
  type: 'text';
  placeholder?: string;
}
export interface EnabledField {
  type: 'enabled';
}

export type FieldDef = NumberField | CheckboxField | SelectField | TextField | EnabledField;

export interface SectionDef {
  title: string;
  fields: FieldDef[];
}

export interface PaneDef {
  id: string;
  label: string;
  sections: SectionDef[];
}
