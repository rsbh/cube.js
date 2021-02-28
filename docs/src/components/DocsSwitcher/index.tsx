import { Button } from 'antd';
import React from 'react';

import styles from './styles.module.scss';
import cubeJsLogo from './cube.js-logo.svg';
import cubeCloudLogo from './cube-cloud-logo.svg';

const SIZE = 'large';

export const DocsSwitcher = () => {
  return (
    <Button.Group size={SIZE} className={styles.docsSwitcher}>
      <Button size={SIZE}>
        <img src={cubeJsLogo} alt="Cube.js Logo" style={{ height: 36 }} />
      </Button>
      <Button size={SIZE}>
        <img src={cubeCloudLogo} alt="Cube Cloud Logo" style={{ height: 36 }} />
      </Button>
    </Button.Group>
  );
};
