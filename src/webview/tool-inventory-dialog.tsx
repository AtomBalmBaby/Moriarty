import React, { useState, useMemo } from 'react';
import styles from './styles/tool-inventory-dialog.module.css';

export interface ToolInfo {
  server: string;
  tool: string;
  name: string;
  description?: string;
}

export interface ToolInventoryDialogProps {
  inventory: ToolInfo[];
  onClose: () => void;
  onConfirm: (selected: ToolInfo[]) => void;
}

export const ToolInventoryDialog: React.FC<ToolInventoryDialogProps> = ({ inventory, onClose, onConfirm }) => {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const lower = search.toLowerCase();
    return inventory.filter(t => t.name.toLowerCase().includes(lower) || (t.description && t.description.toLowerCase().includes(lower)));
  }, [search, inventory]);

  const groups = useMemo(() => {
    const map = new Map<string, ToolInfo[]>();
    filtered.forEach(t => {
      const key = t.server;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    });
    return map;
  }, [filtered]);

  const toggleGroup = (server: string) => {
    setExpandedGroups(prev => {
      const newSet = new Set(prev);
      if (newSet.has(server)) newSet.delete(server); else newSet.add(server);
      return newSet;
    });
  };

  const toggleTool = (t: ToolInfo) => {
    const key = `${t.server}/${t.tool}`;
    setSelected(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) newSet.delete(key); else newSet.add(key);
      return newSet;
    });
  };

  const isGroupSelected = (server: string) => {
    const groupTools = groups.get(server) || [];
    if (groupTools.length === 0) return false;
    return groupTools.every(t => selected.has(`${t.server}/${t.tool}`));
  };

  const isGroupIndeterminate = (server: string) => {
    const groupTools = groups.get(server) || [];
    const selectedCount = groupTools.filter(t => selected.has(`${t.server}/${t.tool}`)).length;
    return selectedCount > 0 && selectedCount < groupTools.length;
  };

  const selectAll = () => {
    const allKeys = inventory.map(t => `${t.server}/${t.tool}`);
    setSelected(new Set(allKeys));
  };

  const selectNone = () => {
    setSelected(new Set());
  };

  const handleConfirm = () => {
    const selectedTools = inventory.filter(t => selected.has(`${t.server}/${t.tool}`));
    onConfirm(selectedTools);
    onClose();
  };

  return (
    <div className={styles.dialogOverlay} onClick={onClose}>
      <div className={styles.dialogContainer} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <strong>Configure Tools</strong>
          <button className={styles.close} onClick={onClose}>✕</button>
        </div>
        <input
          type="text"
          placeholder="Search tools…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className={styles.search}
        />
        {[...groups.entries()].map(([server, tools]) => (
          <div key={server}>
            <div className={styles.groupHeader} onClick={() => toggleGroup(server)}>
              <input
                type="checkbox"
                className={styles.groupCheckbox}
                checked={isGroupSelected(server)}
                ref={el => {
                  if (el) el.indeterminate = isGroupIndeterminate(server);
                }}
                onChange={() => {
                  const allSelected = isGroupSelected(server);
                  const newSet = new Set(selected);
                  tools.forEach(t => {
                    const key = `${t.server}/${t.tool}`;
                    if (allSelected) newSet.delete(key); else newSet.add(key);
                  });
                  setSelected(newSet);
                }}
              />
              <span>{server}</span>
            </div>
            {expandedGroups.has(server) && tools.map(t => {
              const key = `${t.server}/${t.tool}`;
              return (
                <div key={key} className={styles.toolItem} title={t.description ?? ''}>
                  <input
                    type="checkbox"
                    className={styles.toolCheckbox}
                    checked={selected.has(key)}
                    onChange={() => toggleTool(t)}
                  />
                  <span>{t.name}</span>
                </div>
              );
            })}
          </div>
        ))}
        <div className={styles.actions}>
          <button onClick={selectAll}>Select All</button>
          <button onClick={selectNone}>Select None</button>
          <span>{selected.size} selected</span>
          <button onClick={handleConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
};
