// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// Ground truth: vuln-test-v1-reentrancy (see fixtures/GROUND_TRUTH.json)

contract VaultV1 {
    mapping(address => uint256) public balances;
    mapping(address => uint256) public depositTimestamp;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    function deposit() external payable {
        require(msg.value > 0, "Zero deposit");
        balances[msg.sender] += msg.value;
        depositTimestamp[msg.sender] = block.timestamp;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "Nothing to withdraw");

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        balances[msg.sender] = 0;
        depositTimestamp[msg.sender] = 0;

        emit Withdrawn(msg.sender, amount);
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
