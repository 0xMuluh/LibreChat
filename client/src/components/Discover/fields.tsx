import { Circle, Dna, Grid3x3, Layers, Microscope, Atom, FlaskConical } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Fields in the order the filters show them. */
export const FIELD_ORDER = [
  'Microbiome',
  'Single-cell',
  'Spatial',
  'Multi-omics',
  'Bulk RNA-seq',
  'Metabolomics',
  'Proteomics',
];

const FIELD_ICONS: Record<string, LucideIcon> = {
  Microbiome: Microscope,
  'Single-cell': Circle,
  Spatial: Grid3x3,
  'Multi-omics': Layers,
  'Bulk RNA-seq': Dna,
  Metabolomics: FlaskConical,
  Proteomics: Atom,
};

export const fieldIcon = (field: string): LucideIcon => FIELD_ICONS[field] ?? Layers;

export const sortFields = (fields: string[]) =>
  [...fields].sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a);
    const ib = FIELD_ORDER.indexOf(b);
    return (ia < 0 ? FIELD_ORDER.length : ia) - (ib < 0 ? FIELD_ORDER.length : ib);
  });
